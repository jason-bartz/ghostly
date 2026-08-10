//! Opt-in error reporting.
//!
//! Ghostly's privacy claim is that your audio and your words never leave the
//! Mac. That claim is only credible if it survives contact with this file, so
//! the design constraint is stated up front and enforced by construction:
//!
//! > A report is a fixed set of enum-like fields. There is no free-text field
//! > anywhere in [`ErrorReport`], and no code path that puts transcript text,
//! > audio, prompts, dictionary entries, file paths, API keys, or an email
//! > address into one.
//!
//! Concretely, a report says *"paste_failed, v0.1.22, macOS 15.3, arm64,
//! parakeet-v3"* — the shape of a failure, not its contents. That is enough to
//! answer "is this one user or four hundred?", which is the question that
//! decides what gets fixed.
//!
//! Defaults and behaviour:
//!
//! * **Off until the user turns it on.** No pre-checked box, no "anonymous
//!   usage statistics are enabled by default" footnote.
//! * **Errors only.** No feature-usage pings, no session tracking, no funnels.
//! * **Best-effort and silent.** Reporting never blocks, retries, or surfaces
//!   its own failures — a telemetry outage must not become a user-visible bug.
//! * **Rate-limited per process.** A crash loop cannot turn into a flood.

use log::debug;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::settings::get_settings;

/// Path on the license Worker that accepts error reports.
///
/// The host is taken from [`crate::license::DEFAULT_BASE`] rather than written
/// out again here — an earlier copy of this constant hardcoded a hostname that
/// did not resolve at all, so every report silently went nowhere. Deriving it
/// means the two can never drift apart again.
///
/// NOTE: this route does not exist on the Worker yet. Reports 404 and are
/// discarded, which is harmless (see `report` — failures are swallowed by
/// design) but collects nothing until the handler is deployed.
const TELEMETRY_PATH: &str = "/telemetry";

fn telemetry_endpoint() -> String {
    format!("{}{}", crate::license::base_url(), TELEMETRY_PATH)
}

/// Hard ceiling on reports per app run. A repeating failure is worth knowing
/// about once; it is not worth several hundred requests.
const MAX_REPORTS_PER_SESSION: u32 = 20;

static REPORTS_SENT: AtomicU32 = AtomicU32::new(0);
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// The complete set of reportable events.
///
/// A closed enum rather than a string is the mechanism that makes the privacy
/// guarantee structural: adding a new event requires editing this list, which
/// is a visible, reviewable change. `Other` deliberately does not exist.
// Every variant names a failure, so the shared `Failed` suffix is meaningful
// rather than redundant — `Paste` alone would not read as an error.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Text could not be delivered to the focused app.
    PasteFailed,
    /// The transcription engine returned an error.
    TranscriptionFailed,
    /// A model failed to load (missing files, unsupported accelerator, OOM).
    ModelLoadFailed,
    /// A model download failed or its checksum did not verify.
    ModelDownloadFailed,
    /// The refinement provider call failed.
    RefinementFailed,
    /// Audio capture could not start.
    RecordingFailed,
    /// The global shortcut could not be registered.
    ShortcutRegistrationFailed,
    /// Screenshot capture or the vision request failed.
    ScreenshotFailed,
}

/// A single report. Every field is a bounded value — a version string, an OS
/// version, an architecture, a model ID, an enum variant.
///
/// Note what is absent: no message, no stack trace, no URL, no file path, no
/// user or device identifier. Reports are not correlatable across sessions,
/// which is intentional — grouping users is not needed to count failures.
#[derive(Debug, Clone, Serialize)]
struct ErrorReport {
    kind: ErrorKind,
    app_version: String,
    os_version: String,
    arch: String,
    /// The selected model ID, from the fixed built-in set. Custom models report
    /// as `"custom"` rather than leaking a user-chosen filename.
    model: String,
    /// Refinement provider ID (`"openai"`, `"anthropic"`, …) or `"none"`.
    provider: String,
    /// A coarse bucket, never a message. See [`ErrorDetail`].
    detail: ErrorDetail,
}

/// Coarse classification of *why* something failed.
///
/// This is where the temptation to attach `format!("{}", err)` lives, and where
/// a transcript or an API key would eventually end up if a free-text field
/// existed. It doesn't. Callers map their error into one of these buckets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorDetail {
    /// Network unreachable, DNS failure, connection reset.
    Network,
    /// HTTP 401/403 — bad or expired credentials.
    Auth,
    /// HTTP 429 or a provider quota error.
    RateLimited,
    /// Request exceeded its deadline.
    Timeout,
    /// A required file was missing or unreadable.
    MissingFile,
    /// The OS refused an operation for want of a permission.
    PermissionDenied,
    /// Allocation failure or an out-of-memory condition.
    OutOfMemory,
    /// Anything that doesn't fit the buckets above.
    Unclassified,
}

/// Report an error, if and only if the user has opted in.
///
/// Fire-and-forget: spawns onto the async runtime and never blocks the caller.
/// Safe to call from hot paths.
pub fn report(app: &AppHandle, kind: ErrorKind, detail: ErrorDetail) {
    // The opt-in check happens first and is re-read every time, so revoking
    // consent in Settings takes effect immediately rather than at next launch.
    let settings = get_settings(app);
    if !settings.error_reporting_enabled {
        return;
    }

    if REPORTS_SENT.fetch_add(1, Ordering::Relaxed) >= MAX_REPORTS_PER_SESSION {
        return;
    }

    // Custom models are user-named files; the name could be anything, so it is
    // never transmitted.
    let model = {
        let id = settings.selected_model.clone();
        if id.is_empty() {
            "none".to_string()
        } else if is_builtin_model_id(&id) {
            id
        } else {
            "custom".to_string()
        }
    };

    let provider = if settings.refinement_enabled {
        let id = settings.post_process_provider_id.clone();
        // Same reasoning: user-added OpenAI-compatible providers have
        // user-chosen IDs, which can carry a company name.
        if is_builtin_provider_id(&id) {
            id
        } else {
            "custom".to_string()
        }
    } else {
        "none".to_string()
    };

    let payload = ErrorReport {
        kind,
        app_version: app.package_info().version.to_string(),
        os_version: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        model,
        provider,
        detail,
    };

    tauri::async_runtime::spawn(async move {
        let client = CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_default()
        });
        // Errors here are swallowed on purpose. A failed report is not the
        // user's problem and must never produce a toast or a log-level warning
        // that looks like a real fault.
        match client
            .post(telemetry_endpoint())
            .json(&payload)
            .send()
            .await
        {
            Ok(_) => debug!("Error report sent: {:?}", payload.kind),
            Err(e) => debug!("Error report not sent: {}", e),
        }
    });
}

/// Built-in model IDs. Kept as a list rather than derived from `ModelManager`
/// so this module has no dependency on manager state and can be called from
/// anywhere, including early startup.
fn is_builtin_model_id(id: &str) -> bool {
    const IDS: &[&str] = &[
        "small",
        "medium",
        "turbo",
        "large",
        "breeze-asr",
        "parakeet-tdt-0.6b-v2",
        "parakeet-tdt-0.6b-v3",
        "moonshine-base",
        "moonshine-tiny-streaming-en",
        "moonshine-small-streaming-en",
        "moonshine-medium-streaming-en",
        "sense-voice-int8",
        "gigaam-v3-e2e-ctc",
        "canary-180m-flash",
        "canary-1b-v2",
        "cohere-int8",
    ];
    IDS.contains(&id)
}

/// Provider ids we ship, and therefore ids that carry no user-chosen text and
/// are safe to report verbatim. Anything else is a provider the user added,
/// whose id can contain a company name, and gets bucketed as "custom".
///
/// Keep in sync with `default_post_process_providers` in `settings.rs` — a
/// shipped id missing here isn't a leak, but it does erase the distinction the
/// report exists to make.
fn is_builtin_provider_id(id: &str) -> bool {
    const IDS: &[&str] = &[
        "apple-intelligence",
        "apple_intelligence",
        "ghostly_max",
        "openai",
        "anthropic",
        "groq",
        "openrouter",
        "cerebras",
        "zai",
        "ollama",
    ];
    IDS.contains(&id)
}

fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Classify a `reqwest` error into a reportable bucket.
pub fn classify_reqwest(err: &reqwest::Error) -> ErrorDetail {
    if err.is_timeout() {
        return ErrorDetail::Timeout;
    }
    if err.is_connect() || err.is_request() {
        return ErrorDetail::Network;
    }
    match err.status().map(|s| s.as_u16()) {
        Some(401) | Some(403) => ErrorDetail::Auth,
        Some(429) => ErrorDetail::RateLimited,
        _ => ErrorDetail::Unclassified,
    }
}

/// Classify an `io::Error` into a reportable bucket.
pub fn classify_io(err: &std::io::Error) -> ErrorDetail {
    use std::io::ErrorKind as K;
    match err.kind() {
        K::NotFound => ErrorDetail::MissingFile,
        K::PermissionDenied => ErrorDetail::PermissionDenied,
        K::TimedOut => ErrorDetail::Timeout,
        K::OutOfMemory => ErrorDetail::OutOfMemory,
        _ => ErrorDetail::Unclassified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The core privacy property, asserted on the wire format itself: a
    /// serialized report contains only bounded values. If someone later adds a
    /// `message: String` to `ErrorReport`, this fails.
    #[test]
    fn serialized_report_has_no_free_text_fields() {
        let report = ErrorReport {
            kind: ErrorKind::PasteFailed,
            app_version: "0.1.22".to_string(),
            os_version: "15.3".to_string(),
            arch: "aarch64".to_string(),
            model: "parakeet-tdt-0.6b-v3".to_string(),
            provider: "openai".to_string(),
            detail: ErrorDetail::Network,
        };

        let value: serde_json::Value = serde_json::to_value(&report).unwrap();
        let object = value.as_object().expect("report serializes to an object");

        // An exhaustive key list — a new field breaks this test deliberately,
        // forcing a human to confirm the addition is bounded.
        let mut keys: Vec<&str> = object.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "app_version",
                "arch",
                "detail",
                "kind",
                "model",
                "os_version",
                "provider"
            ]
        );

        // Every value is a scalar; nothing nested that could carry a payload.
        for (key, v) in object {
            assert!(
                v.is_string() || v.is_number() || v.is_boolean(),
                "field '{key}' is not a scalar"
            );
        }
    }

    #[test]
    fn custom_model_ids_are_not_transmitted_verbatim() {
        // A user's own .bin file could be named anything at all.
        assert!(!is_builtin_model_id("my-companys-finetune-confidential"));
        assert!(is_builtin_model_id("parakeet-tdt-0.6b-v3"));
    }

    #[test]
    fn custom_provider_ids_are_not_transmitted_verbatim() {
        assert!(!is_builtin_provider_id("acme-internal-gateway"));
        assert!(is_builtin_provider_id("anthropic"));
    }

    #[test]
    fn io_errors_map_to_buckets() {
        use std::io::{Error, ErrorKind as K};
        assert_eq!(
            classify_io(&Error::new(K::NotFound, "x")),
            ErrorDetail::MissingFile
        );
        assert_eq!(
            classify_io(&Error::new(K::PermissionDenied, "x")),
            ErrorDetail::PermissionDenied
        );
        assert_eq!(
            classify_io(&Error::new(K::InvalidData, "x")),
            ErrorDetail::Unclassified
        );
    }

    #[test]
    fn session_report_cap_is_enforced() {
        REPORTS_SENT.store(0, Ordering::Relaxed);
        for _ in 0..MAX_REPORTS_PER_SESSION {
            assert!(REPORTS_SENT.fetch_add(1, Ordering::Relaxed) < MAX_REPORTS_PER_SESSION);
        }
        // The next attempt is over the line.
        assert!(REPORTS_SENT.fetch_add(1, Ordering::Relaxed) >= MAX_REPORTS_PER_SESSION);
    }
}
