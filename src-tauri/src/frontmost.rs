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
