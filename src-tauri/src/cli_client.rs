//! The `ghostly` command's client half.
//!
//! Fire-and-forget flags (`--toggle-transcription`, `--cancel`) are delivered
//! by launching a second instance and letting `tauri_plugin_single_instance`
//! hand the args to the running app. That transport is one-way, so anything
//! that needs a value *back* — `--dictate`, `--status`, `--history` — talks to
//! the localhost API instead.
//!
//! Reading port and token straight out of the settings file is what keeps this
//! pleasant: no environment variables, no pasting tokens into scripts.

use crate::cli::CliArgs;
use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

const STORE_FILE: &str = "settings_store.json";
const APP_IDENTIFIER: &str = "com.getghostly.desktop";

struct Connection {
    base: String,
    token: String,
}

#[derive(Deserialize)]
struct StoredSettings {
    #[serde(default)]
    rest_api_enabled: bool,
    #[serde(default)]
    rest_api_port: u16,
    #[serde(default)]
    rest_api_token: String,
}

fn settings_path() -> Option<PathBuf> {
    crate::portable::init();
    if let Some(dir) = crate::portable::data_dir() {
        return Some(dir.join(STORE_FILE));
    }
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(APP_IDENTIFIER)
            .join(STORE_FILE),
    )
}

fn load_connection() -> Result<Connection, String> {
    let path = settings_path().ok_or("Could not locate your Ghostly settings.")?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "Ghostly has not been set up on this machine yet.".to_string())?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Could not read settings: {e}"))?;
    let settings: StoredSettings = serde_json::from_value(
        root.get("settings")
            .cloned()
            .ok_or("Could not read settings.")?,
    )
    .map_err(|e| format!("Could not read settings: {e}"))?;

    if !settings.rest_api_enabled || settings.rest_api_token.is_empty() {
        return Err(
            "The Ghostly local API is off. Turn it on in Settings → Developer → Local API."
                .to_string(),
        );
    }

    Ok(Connection {
        base: format!("http://127.0.0.1:{}", settings.rest_api_port),
        token: settings.rest_api_token,
    })
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Could not start the HTTP client: {e}"))
}

fn client(conn: &Connection, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", conn.token))
        .map_err(|_| "Invalid API token in settings.".to_string())?;
    value.set_sensitive(true);
    headers.insert(reqwest::header::AUTHORIZATION, value);

    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Could not start the HTTP client: {e}"))
}

fn connection_refused_hint(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Ghostly is not running. Launch it and try again.".to_string()
    } else if e.is_timeout() {
        "Timed out talking to Ghostly.".to_string()
    } else {
        format!("Could not reach Ghostly: {e}")
    }
}

/// Handle a CLI flag that needs a response. Returns `None` when the args
/// are not for us, so the caller falls through to launching the app.
pub fn run(args: &CliArgs) -> Option<i32> {
    if args.install_cli {
        return Some(run_install_cli());
    }
    if args.status {
        return Some(dispatch(|| cmd_status(args)));
    }
    if args.history {
        return Some(dispatch(|| cmd_history(args)));
    }
    if args.dictate {
        return Some(dispatch(|| cmd_dictate(args)));
    }
    None
}

fn dispatch(f: impl FnOnce() -> Result<(), String>) -> i32 {
    match f() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("ghostly: {message}");
            1
        }
    }
}

fn run_install_cli() -> i32 {
    match crate::cli_install::install() {
        Ok(result) => {
            println!("Installed the ghostly command at {}", result.path);
            if let Some(hint) = result.path_hint {
                println!();
                println!("That directory is not on your PATH yet. Add this to your shell profile:");
                println!("  {hint}");
            }
            0
        }
        Err(e) => {
            eprintln!("ghostly: could not install the command: {e}");
            1
        }
    }
}

fn cmd_status(args: &CliArgs) -> Result<(), String> {
    let conn = load_connection()?;
    let rt = runtime()?;
    let client = client(&conn, Duration::from_secs(10))?;

    let body: serde_json::Value = rt.block_on(async {
        client
            .get(format!("{}/api/status", conn.base))
            .send()
            .await
            .map_err(|e| connection_refused_hint(&e))?
            .json()
            .await
            .map_err(|e| format!("Unexpected response from Ghostly: {e}"))
    })?;

    if args.json {
        println!("{}", body);
    } else {
        let recording = body
            .get("is_recording")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let version = body
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        println!(
            "Ghostly {version} — {}",
            if recording { "recording" } else { "idle" }
        );
    }
    Ok(())
}

fn cmd_history(args: &CliArgs) -> Result<(), String> {
    let conn = load_connection()?;
    let rt = runtime()?;
    let client = client(&conn, Duration::from_secs(15))?;
    let limit = args.limit.unwrap_or(10);

    let body: serde_json::Value = rt.block_on(async {
        client
            .get(format!("{}/api/history?limit={}", conn.base, limit))
            .send()
            .await
            .map_err(|e| connection_refused_hint(&e))?
            .json()
            .await
            .map_err(|e| format!("Unexpected response from Ghostly: {e}"))
    })?;

    if args.json {
        println!("{}", body);
        return Ok(());
    }

    let entries = body
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    if entries.is_empty() {
        eprintln!("No transcriptions yet.");
        return Ok(());
    }

    for entry in entries {
        let text = entry
            .get("post_processed_text")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("transcription_text").and_then(|v| v.as_str()))
            .unwrap_or("");
        println!("{text}");
    }
    Ok(())
}

fn cmd_dictate(args: &CliArgs) -> Result<(), String> {
    let conn = load_connection()?;
    let timeout_secs = args.timeout.unwrap_or(120);
    let rt = runtime()?;
    // Allow generous headroom over the server-side wait so the server's own
    // timeout is what fires, producing a clearer message than a client abort.
    let client = client(&conn, Duration::from_secs(timeout_secs + 15))?;

    let mut body = serde_json::json!({
        "timeout_ms": timeout_secs * 1000,
        "paste": args.paste,
    });
    if let Some(stop_after) = args.stop_after {
        body["stop_after_ms"] = serde_json::json!(stop_after * 1000);
        eprintln!("Recording for {stop_after}s…");
    } else {
        eprintln!("Recording… stop with your Ghostly shortcut. Ctrl-C to cancel.");
    }

    install_cancel_on_interrupt(&conn);

    // Progress goes to stderr so `$(ghostly --dictate)` captures only the text.
    let _ = std::io::stderr().flush();

    let response: serde_json::Value = rt.block_on(async {
        let res = client
            .post(format!("{}/api/dictate", conn.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| connection_refused_hint(&e))?;

        let status = res.status();
        let parsed: serde_json::Value = res
            .json()
            .await
            .map_err(|e| format!("Unexpected response from Ghostly: {e}"))?;

        if !status.is_success() {
            let message = parsed
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Dictation failed")
                .to_string();
            return Err(message);
        }
        Ok(parsed)
    })?;

    if args.json {
        println!("{}", response);
    } else {
        let text = response.get("text").and_then(|v| v.as_str()).unwrap_or("");
        println!("{text}");
    }
    Ok(())
}

/// Ctrl-C during `--dictate` should stop the app recording too, not just
/// detach the terminal from it.
fn install_cancel_on_interrupt(conn: &Connection) {
    let base = conn.base.clone();
    let token = conn.token.clone();
    std::thread::spawn(move || {
        let Ok(mut signals) = signal_hook::iterator::Signals::new([signal_hook::consts::SIGINT])
        else {
            return;
        };
        if signals.forever().next().is_some() {
            eprintln!("\nCancelling…");
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                let _ = rt.block_on(async {
                    reqwest::Client::new()
                        .post(format!("{base}/api/cancel"))
                        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                        .timeout(Duration::from_secs(5))
                        .send()
                        .await
                });
            }
            std::process::exit(130);
        }
    });
}
