//! Self-serve triage and support tooling.
//!
//! Ghostly runs entirely on the user's machine, which is the whole point — and
//! also means that when something breaks, no server-side trace exists to look
//! at. Historically the only recourse was "please find your log directory and
//! email me the files", which most users never complete.
//!
//! Two things live here:
//!
//!   * [`run_health_check`] — inspects the handful of conditions that account
//!     for nearly every "it just stopped working" report (permissions revoked
//!     by a macOS update, model files missing, no input device, refinement
//!     endpoint unreachable) and reports each as pass/warn/fail with a concrete
//!     next action. Users fix most of these without ever contacting support.
//!
//!   * [`export_diagnostics_bundle`] — one click produces a zip containing the
//!     recent logs, a **redacted** settings dump, and environment facts. This
//!     is what makes an emailed bug report actionable.
//!
//! Redaction is not best-effort here. The bundle is something users hand to a
//! stranger, so the settings dump is built by *allowlist* — fields are copied
//! in one at a time — rather than by serializing `AppSettings` and deleting the
//! scary-looking keys. A denylist silently leaks every field added later.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::settings::get_settings;

/// Outcome of a single health check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum HealthStatus {
    /// Working as intended.
    Pass,
    /// Functional but degraded, or an optional feature is unconfigured.
    Warn,
    /// Core dictation is broken until the user acts.
    Fail,
}

/// What the user should do about a non-passing check. The frontend maps this to
/// a button rather than making the user hunt through System Settings.
// The `Open` prefix is the point: every variant is an action the UI turns into
// a button, and dropping it would make `Models`/`Audio` read as nouns.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum HealthAction {
    /// Open System Settings › Privacy & Security › Microphone.
    OpenMicrophoneSettings,
    /// Open System Settings › Privacy & Security › Accessibility.
    OpenAccessibilitySettings,
    /// Jump to the in-app Models screen.
    OpenModels,
    /// Jump to the in-app Refinement screen.
    OpenRefinement,
    /// Jump to the in-app Audio settings.
    OpenAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HealthCheck {
    /// Stable identifier — the frontend keys translations off this, so the
    /// human-readable strings below never reach the UI directly.
    pub id: String,
    pub status: HealthStatus,
    /// English fallback detail (e.g. "Whisper Large — 1031 MB"). Shown verbatim
    /// only when it carries specifics the translated label can't.
    pub detail: Option<String>,
    pub action: Option<HealthAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HealthReport {
    pub checks: Vec<HealthCheck>,
    /// Worst status across all checks — drives the summary banner.
    pub overall: HealthStatus,
}

impl HealthCheck {
    fn pass(id: &str, detail: Option<String>) -> Self {
        Self {
            id: id.to_string(),
            status: HealthStatus::Pass,
            detail,
            action: None,
        }
    }

    fn warn(id: &str, detail: Option<String>, action: Option<HealthAction>) -> Self {
        Self {
            id: id.to_string(),
            status: HealthStatus::Warn,
            detail,
            action,
        }
    }

    fn fail(id: &str, detail: Option<String>, action: Option<HealthAction>) -> Self {
        Self {
            id: id.to_string(),
            status: HealthStatus::Fail,
            detail,
            action,
        }
    }
}

/// Run every health check and return a report.
///
/// Deliberately does no network I/O beyond a short, bounded reachability probe
/// of the configured refinement endpoint — this runs on a settings screen the
/// user is staring at, so it must return promptly.
#[tauri::command]
#[specta::specta]
pub async fn run_health_check(app: AppHandle) -> Result<HealthReport, String> {
    let settings = get_settings(&app);
    let mut checks = Vec::new();

    // --- Microphone permission -------------------------------------------
    // Without this the app records silence and transcribes nothing, with no
    // obvious error — the single most confusing failure mode there is.
    if tauri_plugin_macos_permissions::check_microphone_permission().await {
        checks.push(HealthCheck::pass("microphone", None));
    } else {
        checks.push(HealthCheck::fail(
            "microphone",
            None,
            Some(HealthAction::OpenMicrophoneSettings),
        ));
    }

    // --- Accessibility permission ----------------------------------------
    // Required both for the global shortcut and for pasting into other apps.
    // macOS silently revokes this when the app binary changes, which means an
    // ordinary update can break dictation.
    if tauri_plugin_macos_permissions::check_accessibility_permission().await {
        checks.push(HealthCheck::pass("accessibility", None));
    } else {
        checks.push(HealthCheck::fail(
            "accessibility",
            None,
            Some(HealthAction::OpenAccessibilitySettings),
        ));
    }

    // --- Transcription model ---------------------------------------------
    checks.push(check_model(&app, &settings.selected_model));

    // --- Input device -----------------------------------------------------
    checks.push(check_input_device(settings.selected_microphone.as_deref()));

    // --- Refinement provider ---------------------------------------------
    checks.push(check_refinement(&app, &settings).await);

    // --- Shortcut bound ---------------------------------------------------
    // An unbound transcribe shortcut is a silently dead app.
    let has_transcribe_binding = settings
        .bindings
        .get("transcribe")
        .map(|b| !b.current_binding.trim().is_empty())
        .unwrap_or(false);
    checks.push(if has_transcribe_binding {
        HealthCheck::pass(
            "shortcut",
            settings
                .bindings
                .get("transcribe")
                .map(|b| b.current_binding.clone()),
        )
    } else {
        HealthCheck::fail("shortcut", None, None)
    });

    let overall = checks
        .iter()
        .map(|c| c.status)
        .fold(HealthStatus::Pass, |acc, s| match (acc, s) {
            (HealthStatus::Fail, _) | (_, HealthStatus::Fail) => HealthStatus::Fail,
            (HealthStatus::Warn, _) | (_, HealthStatus::Warn) => HealthStatus::Warn,
            _ => HealthStatus::Pass,
        });

    Ok(HealthReport { checks, overall })
}

/// Verify the selected model exists on disk and is non-empty.
///
/// Checks bytes rather than mere existence: an interrupted download or a
/// half-restored backup leaves a zero-length file that passes `exists()` and
/// then fails deep inside the inference engine with an opaque error.
fn check_model(app: &AppHandle, selected_model: &str) -> HealthCheck {
    if selected_model.is_empty() {
        return HealthCheck::fail("model", None, Some(HealthAction::OpenModels));
    }

    let Some(manager) = app.try_state::<std::sync::Arc<crate::managers::model::ModelManager>>()
    else {
        return HealthCheck::warn("model", None, None);
    };
    let Some(info) = manager.get_model_info(selected_model) else {
        return HealthCheck::fail(
            "model",
            Some(selected_model.to_string()),
            Some(HealthAction::OpenModels),
        );
    };

    let Ok(models_dir) = crate::portable::app_data_dir(app).map(|d| d.join("models")) else {
        return HealthCheck::warn("model", Some(info.name.clone()), None);
    };
    let path = models_dir.join(&info.filename);

    let present = if info.is_directory {
        // A model directory with no files in it is not a model.
        path.is_dir()
            && fs::read_dir(&path)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false)
    } else {
        path.metadata().map(|m| m.len() > 0).unwrap_or(false)
    };

    if present {
        HealthCheck::pass("model", Some(info.name))
    } else {
        HealthCheck::fail("model", Some(info.name), Some(HealthAction::OpenModels))
    }
}

/// Confirm an input device is actually available.
///
/// A user who selected a USB microphone and then unplugged it gets recordings
/// of nothing; surfacing the stale selection explains it immediately.
fn check_input_device(selected: Option<&str>) -> HealthCheck {
    let devices = match crate::commands::audio::get_available_microphones() {
        Ok(d) => d,
        Err(e) => return HealthCheck::warn("inputDevice", Some(truncate(&e, 120)), None),
    };

    // `get_available_microphones` always prepends a synthetic "Default" entry,
    // so a machine with no hardware input still returns one item.
    let real_devices: Vec<&str> = devices
        .iter()
        .filter(|d| d.index != "default")
        .map(|d| d.name.as_str())
        .collect();

    if real_devices.is_empty() {
        return HealthCheck::fail("inputDevice", None, Some(HealthAction::OpenAudio));
    }

    match selected {
        // Explicit device selection that no longer resolves — almost always an
        // unplugged USB or Bluetooth mic.
        Some(name) if !name.is_empty() && !real_devices.contains(&name) => HealthCheck::warn(
            "inputDeviceMissing",
            Some(name.to_string()),
            Some(HealthAction::OpenAudio),
        ),
        Some(name) if !name.is_empty() => HealthCheck::pass("inputDevice", Some(name.to_string())),
        // Following the system default device.
        _ => HealthCheck::pass("inputDevice", None),
    }
}

/// Probe the refinement provider, if one is configured.
///
/// Reports `Warn` rather than `Fail` throughout: refinement is optional and the
/// pipeline falls back to pasting the raw transcript, so a dead endpoint
/// degrades quality but never blocks dictation.
async fn check_refinement(app: &AppHandle, settings: &crate::settings::AppSettings) -> HealthCheck {
    if !settings.refinement_enabled {
        return HealthCheck::pass("refinementOff", None);
    }

    let Some(provider) = settings.active_post_process_provider().cloned() else {
        return HealthCheck::warn(
            "refinementNoProvider",
            None,
            Some(HealthAction::OpenRefinement),
        );
    };

    // Reuse the exact probe the Refinement screen's "Test connection" button
    // runs, so the two screens can never disagree about whether it works.
    match crate::commands::transcription::test_post_process_connection(app.clone()).await {
        Ok(()) => HealthCheck::pass("refinement", Some(provider.label.clone())),
        Err(e) => HealthCheck::warn(
            "refinementUnreachable",
            Some(format!("{} — {}", provider.label, truncate(&e, 120))),
            Some(HealthAction::OpenRefinement),
        ),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ---------------------------------------------------------------------------
// Diagnostics bundle
// ---------------------------------------------------------------------------

/// Build a support bundle on the Desktop and return its path.
///
/// Contains: the most recent log files, a redacted settings snapshot, and an
/// environment summary. Never contains transcripts, audio, API keys, or license
/// keys.
#[tauri::command]
#[specta::specta]
pub async fn export_diagnostics_bundle(app: AppHandle) -> Result<String, String> {
    let dest_dir = app
        .path()
        .desktop_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Could not resolve a destination directory: {}", e))?;

    // Timestamped so repeated exports during one support thread don't clobber
    // each other and the recipient can tell them apart.
    let stamp = timestamp_slug();
    let bundle_dir = dest_dir.join(format!("Ghostly-Diagnostics-{}", stamp));
    fs::create_dir_all(&bundle_dir)
        .map_err(|e| format!("Could not create {}: {}", bundle_dir.display(), e))?;

    // --- Environment ------------------------------------------------------
    let env_path = bundle_dir.join("environment.txt");
    fs::write(&env_path, environment_summary(&app))
        .map_err(|e| format!("Could not write environment summary: {}", e))?;

    // --- Redacted settings ------------------------------------------------
    let settings_path = bundle_dir.join("settings-redacted.json");
    let redacted = redacted_settings(&app);
    fs::write(
        &settings_path,
        serde_json::to_string_pretty(&redacted)
            .map_err(|e| format!("Could not serialize settings: {}", e))?,
    )
    .map_err(|e| format!("Could not write settings snapshot: {}", e))?;

    // --- Logs -------------------------------------------------------------
    let mut copied_logs = 0usize;
    if let Ok(log_dir) = crate::portable::app_log_dir(&app) {
        let logs_out = bundle_dir.join("logs");
        fs::create_dir_all(&logs_out)
            .map_err(|e| format!("Could not create logs directory: {}", e))?;
        copied_logs = copy_recent_logs(&log_dir, &logs_out).unwrap_or(0);
    }

    // A README saves the user from wondering what they're about to send, and
    // saves support from being asked "does this contain what I said?".
    let readme = format!(
        "Ghostly diagnostics bundle\n\
         Generated: {}\n\n\
         Contents\n\
         --------\n\
         environment.txt        App version, macOS version, hardware, permissions.\n\
         settings-redacted.json Your settings, with all secrets removed.\n\
         logs/                  The {} most recent log file(s).\n\n\
         What is NOT in here\n\
         -------------------\n\
         - Transcripts or dictation history\n\
         - Audio recordings\n\
         - API keys, license keys, or email addresses\n\
         - Custom prompt text or dictionary entries\n\n\
         You can open any of these files in a text editor before sending them.\n",
        stamp, copied_logs
    );
    fs::write(bundle_dir.join("README.txt"), readme)
        .map_err(|e| format!("Could not write README: {}", e))?;

    Ok(bundle_dir.to_string_lossy().to_string())
}

/// Copy the most recent log files, newest first, capped in both count and size.
///
/// Log directories can reach hundreds of megabytes after a long debug session;
/// an unbounded copy would produce a bundle nobody can email.
fn copy_recent_logs(log_dir: &Path, dest: &Path) -> std::io::Result<usize> {
    const MAX_FILES: usize = 3;
    const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024;

    let mut entries: Vec<(PathBuf, std::time::SystemTime, u64)> = fs::read_dir(log_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.modified().ok()?, meta.len()))
        })
        .collect();

    // Newest first.
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let mut total = 0u64;
    let mut copied = 0usize;
    for (path, _, len) in entries.into_iter().take(MAX_FILES) {
        if total.saturating_add(len) > MAX_TOTAL_BYTES {
            // Take the tail of an oversized log rather than skipping it — the
            // end of the file is where the crash is.
            if let Some(name) = path.file_name() {
                if let Ok(tail) = read_tail(&path, MAX_TOTAL_BYTES / 2) {
                    let out = dest.join(format!("{}.tail", name.to_string_lossy()));
                    fs::write(&out, tail)?;
                    copied += 1;
                }
            }
            break;
        }
        if let Some(name) = path.file_name() {
            fs::copy(&path, dest.join(name))?;
            total += len;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Read the last `bytes` of a file, snapped forward to the next line boundary
/// so the excerpt doesn't begin mid-UTF-8-sequence.
fn read_tail(path: &Path, bytes: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    if start > 0 {
        if let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            buf.drain(..=nl);
        }
    }
    Ok(buf)
}

fn environment_summary(app: &AppHandle) -> String {
    let settings = get_settings(app);
    let mut out = String::new();
    let mut line = |k: &str, v: String| {
        out.push_str(&format!("{:<24}{}\n", k, v));
    };

    line("App version", app.package_info().version.to_string());
    line("OS", format!("{} {}", std::env::consts::OS, os_version()));
    line("Architecture", std::env::consts::ARCH.to_string());
    line(
        "Portable install",
        crate::portable::is_portable().to_string(),
    );
    line("Selected model", settings.selected_model.clone());
    line("Language", settings.selected_language.clone());
    line("App language", settings.app_language.clone());
    line(
        "Refinement enabled",
        settings.refinement_enabled.to_string(),
    );
    line(
        "Refinement provider",
        settings.post_process_provider_id.clone(),
    );
    line(
        "Whisper accelerator",
        format!("{:?}", settings.whisper_accelerator),
    );
    line("ORT accelerator", format!("{:?}", settings.ort_accelerator));
    line(
        "Keyboard impl",
        format!("{:?}", settings.keyboard_implementation),
    );
    line("Paste method", format!("{:?}", settings.paste_method));
    line("Typing tool", format!("{:?}", settings.typing_tool));
    line("Profiles enabled", settings.profiles_enabled.to_string());
    line("Profile count", settings.profiles.len().to_string());
    line("Custom word count", settings.custom_words.len().to_string());
    line("Debug mode", settings.debug_mode.to_string());
    line("Log level", format!("{:?}", settings.log_level));

    if let Ok(dir) = crate::portable::app_data_dir(app) {
        line("Data directory", dir.display().to_string());
    }
    out
}

fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Build the settings snapshot by **allowlist**.
///
/// Every field is named explicitly. Adding a new setting to `AppSettings` does
/// not add it here, which is the intended failure mode: a field missing from a
/// diagnostics bundle costs one round-trip with the user; a secret leaking into
/// one cannot be undone.
fn redacted_settings(app: &AppHandle) -> serde_json::Value {
    redacted_settings_from(&get_settings(app))
}

fn redacted_settings_from(s: &crate::settings::AppSettings) -> serde_json::Value {
    serde_json::json!({
        "_note": "Allowlisted subset. Secrets, prompts, dictionary entries, and \
                  transcripts are intentionally excluded.",
        "audio": {
            "selected_microphone_set": s.selected_microphone.is_some(),
            "clamshell_microphone_set": s.clamshell_microphone.is_some(),
            "selected_output_device_set": s.selected_output_device.is_some(),
            "always_on_microphone": s.always_on_microphone,
            "mute_while_recording": s.mute_while_recording,
            "audio_feedback": s.audio_feedback,
            "audio_feedback_volume": s.audio_feedback_volume,
            "sound_theme": format!("{:?}", s.sound_theme),
        },
        "transcription": {
            "selected_model": s.selected_model,
            "selected_language": s.selected_language,
            "translate_to_english": s.translate_to_english,
            "whisper_accelerator": format!("{:?}", s.whisper_accelerator),
            "ort_accelerator": format!("{:?}", s.ort_accelerator),
            "whisper_gpu_device": s.whisper_gpu_device,
            "model_unload_timeout": format!("{:?}", s.model_unload_timeout),
            "word_correction_threshold": s.word_correction_threshold,
            "extra_recording_buffer_ms": s.extra_recording_buffer_ms,
        },
        "output": {
            "paste_method": format!("{:?}", s.paste_method),
            "clipboard_handling": format!("{:?}", s.clipboard_handling),
            "typing_tool": format!("{:?}", s.typing_tool),
            "external_script_configured": s.external_script_path.is_some(),
            "paste_delay_ms": s.paste_delay_ms,
            "append_trailing_space": s.append_trailing_space,
            "auto_submit": s.auto_submit,
            "auto_submit_key": format!("{:?}", s.auto_submit_key),
        },
        "refinement": {
            "enabled": s.refinement_enabled,
            "provider_id": s.post_process_provider_id,
            "deterministic_cleanup_in_ai_apps": s.deterministic_cleanup_in_ai_apps,
            "auto_cleanup_level": format!("{:?}", s.auto_cleanup_level),
            // Counts only — prompt bodies are user content.
            "prompt_count": s.post_process_prompts.len(),
            "configured_provider_count": s.post_process_providers.len(),
            "providers_with_keys": s.post_process_providers.iter()
                .filter(|p| s.post_process_api_keys.get(&p.id)
                    .map(|k| !k.trim().is_empty()).unwrap_or(false))
                .count(),
        },
        "shortcuts": {
            "push_to_talk": s.push_to_talk,
            "keyboard_implementation": format!("{:?}", s.keyboard_implementation),
            // Key combinations are not secret and are frequently the bug.
            "bindings": s.bindings.iter()
                .map(|(k, v)| (k.clone(), v.current_binding.clone()))
                .collect::<std::collections::HashMap<_, _>>(),
        },
        "features": {
            "profiles_enabled": s.profiles_enabled,
            "profile_count": s.profiles.len(),
            "builtin_profiles_enabled": s.builtin_profiles_enabled,
            "style_enabled": s.style_enabled,
            "voice_editing_enabled": s.voice_editing_enabled,
            "continuous_dictation_enabled": s.continuous_dictation_enabled,
            "correction_phrases_enabled": s.correction_phrases_enabled,
            "rest_api_enabled": s.rest_api_enabled,
            "experimental_enabled": s.experimental_enabled,
            "custom_word_count": s.custom_words.len(),
        },
        "app": {
            "app_language": s.app_language,
            "start_hidden": s.start_hidden,
            "autostart_enabled": s.autostart_enabled,
            "show_tray_icon": s.show_tray_icon,
            "show_dock_icon": s.show_dock_icon,
            "overlay_position": format!("{:?}", s.overlay_position),
            "history_limit": s.history_limit,
            "recording_retention_period": format!("{:?}", s.recording_retention_period),
            "debug_mode": s.debug_mode,
            "log_level": format!("{:?}", s.log_level),
        },
    })
}

/// `YYYY-MM-DD-HHMM` in local time, for bundle directory names.
fn timestamp_slug() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Avoid pulling in a date crate for a filename: ask the system.
    std::process::Command::new("date")
        .args(["+%Y-%m-%d-%H%M"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| secs.to_string())
}

/// Reveal the generated bundle in Finder.
#[tauri::command]
#[specta::specta]
pub fn reveal_diagnostics_bundle(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("Could not reveal {}: {}", path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::TempDir;

    #[test]
    fn read_tail_returns_end_of_file_on_a_line_boundary() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.log");
        let mut f = fs::File::create(&path).unwrap();
        for i in 0..500 {
            writeln!(f, "line {} padding padding padding", i).unwrap();
        }
        drop(f);

        let tail = read_tail(&path, 200).unwrap();
        let text = String::from_utf8(tail).unwrap();
        // Truncated to roughly the requested size...
        assert!(text.len() <= 200);
        // ...and starts cleanly at a line, never mid-line.
        assert!(text.starts_with("line "));
        assert!(text.contains("line 499"));
    }

    #[test]
    fn read_tail_returns_whole_file_when_smaller_than_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("small.log");
        fs::write(&path, "only line\n").unwrap();

        let tail = read_tail(&path, 4096).unwrap();
        assert_eq!(String::from_utf8(tail).unwrap(), "only line\n");
    }

    #[test]
    fn copy_recent_logs_caps_file_count() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        // Five candidate files; the cap is three. Which three depends on mtime,
        // which we can't set portably without another dependency — so assert
        // the cap and that every copied file came from the source.
        for i in 0..5 {
            fs::write(src.path().join(format!("log{}.txt", i)), "contents").unwrap();
        }

        let copied = copy_recent_logs(src.path(), dst.path()).unwrap();
        assert_eq!(copied, 3);

        let out: Vec<_> = fs::read_dir(dst.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(out.len(), 3);
        for name in out {
            assert!(src.path().join(&name).exists(), "unexpected file {}", name);
        }
    }

    #[test]
    fn copy_recent_logs_ignores_subdirectories() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();
        fs::create_dir(src.path().join("nested")).unwrap();
        fs::write(src.path().join("nested").join("inner.log"), "x").unwrap();
        fs::write(src.path().join("top.log"), "x").unwrap();

        assert_eq!(copy_recent_logs(src.path(), dst.path()).unwrap(), 1);
        assert!(dst.path().join("top.log").exists());
        assert!(!dst.path().join("nested").exists());
    }

    /// The invariant this whole module is built around: secrets and user
    /// content must never reach the bundle. Seeds real settings with
    /// recognisable sentinel values and asserts none of them survive.
    #[test]
    fn redaction_drops_secrets_and_user_content() {
        let mut s = crate::settings::get_default_settings();

        s.post_process_api_keys
            .insert("openai".to_string(), "sk-SENTINEL-APIKEY".to_string());
        s.custom_words.push("SENTINEL-DICTIONARY-WORD".to_string());
        s.correction_phrases.push("SENTINEL-CORRECTION".to_string());
        s.eula_accepted_version = Some("SENTINEL-EULA".to_string());
        s.external_script_path = Some("/Users/someone/SENTINEL-SCRIPT.sh".to_string());
        if let Some(prompt) = s.post_process_prompts.first_mut() {
            prompt.prompt = "SENTINEL-PROMPT-BODY".to_string();
        }

        let json = redacted_settings_from(&s).to_string();

        for sentinel in [
            "SENTINEL-APIKEY",
            "SENTINEL-DICTIONARY-WORD",
            "SENTINEL-CORRECTION",
            "SENTINEL-EULA",
            "SENTINEL-SCRIPT",
            "SENTINEL-PROMPT-BODY",
        ] {
            assert!(
                !json.contains(sentinel),
                "diagnostics bundle leaked {sentinel}"
            );
        }
    }

    /// The bundle still has to be *useful* — a redactor that emits nothing
    /// would pass the test above.
    #[test]
    fn redaction_keeps_the_fields_support_actually_needs() {
        let mut s = crate::settings::get_default_settings();
        s.selected_model = "parakeet-tdt-0.6b-v3".to_string();
        s.post_process_api_keys
            .insert("openai".to_string(), "sk-secret".to_string());
        s.custom_words.push("Ghostly".to_string());

        let value = redacted_settings_from(&s);

        assert_eq!(
            value["transcription"]["selected_model"],
            "parakeet-tdt-0.6b-v3"
        );
        // Counts, not contents.
        assert_eq!(value["features"]["custom_word_count"], 1);
        assert!(value["app"]["log_level"].is_string());
    }

    #[test]
    fn truncate_is_char_safe_on_multibyte_input() {
        // Byte-slicing here would panic; the ellipsis marks the cut.
        let s = "日本語のテキストです".repeat(20);
        let out = truncate(&s, 10);
        assert_eq!(out.chars().count(), 11);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_leaves_short_strings_alone() {
        assert_eq!(truncate("short", 100), "short");
    }
}
