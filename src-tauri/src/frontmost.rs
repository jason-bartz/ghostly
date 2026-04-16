use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppContext {
    pub bundle_id: Option<String>,
    pub process_name: Option<String>,
    pub window_class: Option<String>,
    pub exe_path: Option<String>,
    pub window_title: Option<String>,
}

impl AppContext {
    pub fn is_empty(&self) -> bool {
        self.bundle_id.is_none()
            && self.process_name.is_none()
            && self.window_class.is_none()
            && self.exe_path.is_none()
    }
}

/// Returns `Ok(None)` when detection is unsupported (e.g. Wayland) rather than
/// treating it as an error, so the caller can silently use the default profile.
pub fn current() -> Result<Option<AppContext>, String> {
    #[cfg(target_os = "linux")]
    {
        if crate::utils::is_wayland() {
            return Ok(None);
        }
    }

    match active_win_pos_rs::get_active_window() {
        Ok(w) => {
            let bundle_id = if !w.app_name.is_empty() {
                Some(w.app_name.clone())
            } else {
                None
            };
            let process_name = w
                .process_path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string());
            let exe_path = w.process_path.to_str().map(|s| s.to_string());
            let window_title = if w.title.is_empty() {
                None
            } else {
                Some(w.title.clone())
            };

            #[cfg(target_os = "macos")]
            let (bundle_id, process_name) = {
                // On macOS, active-win-pos-rs puts bundle id in app_name; also
                // expose process_name for users who prefer matching by exe.
                (bundle_id, process_name)
            };

            Ok(Some(AppContext {
                bundle_id,
                process_name,
                window_class: None,
                exe_path,
                window_title,
            }))
        }
        Err(e) => {
            log::debug!("Frontmost app detection failed: {:?}", e);
            Ok(None)
        }
    }
}

/// Tauri command for the settings UI "Detect current app" button.
#[tauri::command]
#[specta::specta]
pub fn detect_frontmost_app() -> Result<Option<AppContext>, String> {
    current()
}

/// Returns the id of the built-in profile that matches the frontmost app,
/// or `None` if no built-in matches. Lets the Vibe Coding tab show "this
/// app has voice commands available" without re-implementing the Rust
/// detection heuristics in TypeScript.
#[tauri::command]
#[specta::specta]
pub fn detect_builtin_profile_id() -> Result<Option<String>, String> {
    let ctx = current()?;
    Ok(ctx.and_then(|c| crate::profiles::match_builtin_profile(&c).map(|p| p.id)))
}

/// Return a short, user-facing name for an app context (for the Notes "captured
/// in" chip). Prefers the macOS bundle's human display name; falls back to
/// stripping `.app` from a process name, then to the bundle id's last segment.
pub fn display_name(ctx: &AppContext) -> Option<String> {
    if let Some(name) = ctx.process_name.as_deref() {
        let trimmed = name.trim_end_matches(".app").trim_end_matches(".exe");
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(bundle) = ctx.bundle_id.as_deref() {
        // `com.apple.Messages` → "Messages"
        let last = bundle.rsplit('.').next().unwrap_or(bundle);
        if !last.is_empty() {
            return Some(last.to_string());
        }
    }
    None
}
