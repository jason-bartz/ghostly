pub mod audio;
pub mod edit_chip;
pub mod history;
pub mod license;
pub mod models;
pub mod profiles;
pub mod transcription;
pub mod usage;

use crate::settings::{get_settings, write_settings, AppSettings, LogLevel};
use crate::utils::cancel_current_operation;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
#[specta::specta]
pub fn cancel_operation(app: AppHandle) {
    cancel_current_operation(&app);
}

/// Clears a staged screenshot capture (invoked from the staged overlay's
/// Cancel button). Also hides the overlay so the user sees immediate feedback.
#[tauri::command]
#[specta::specta]
pub fn cancel_staged_capture(app: AppHandle) {
    if let Some(state) =
        app.try_state::<std::sync::Arc<crate::staged_capture::StagedCaptureState>>()
    {
        state.clear();
    }
    // Release the paste shortcut — otherwise Cmd+V stays hijacked after the
    // user discards the capture.
    crate::shortcut::unregister_confirm_paste_shortcut(&app);
    crate::utils::hide_recording_overlay(&app);
}

#[tauri::command]
#[specta::specta]
pub fn is_portable() -> bool {
    crate::portable::is_portable()
}

#[tauri::command]
#[specta::specta]
pub fn get_app_dir_path(app: AppHandle) -> Result<String, String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    Ok(app_data_dir.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_app_settings(app: AppHandle) -> Result<AppSettings, String> {
    Ok(get_settings(&app))
}

#[tauri::command]
#[specta::specta]
pub fn get_default_settings() -> Result<AppSettings, String> {
    Ok(crate::settings::get_default_settings())
}

#[tauri::command]
#[specta::specta]
pub fn get_log_dir_path(app: AppHandle) -> Result<String, String> {
    let log_dir = crate::portable::app_log_dir(&app)
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    Ok(log_dir.to_string_lossy().to_string())
}

#[specta::specta]
#[tauri::command]
pub fn set_log_level(app: AppHandle, level: LogLevel) -> Result<(), String> {
    let tauri_log_level: tauri_plugin_log::LogLevel = level.into();
    let log_level: log::Level = tauri_log_level.into();
    // Update the file log level atomic so the filter picks up the new level
    crate::FILE_LOG_LEVEL.store(
        log_level.to_level_filter() as u8,
        std::sync::atomic::Ordering::Relaxed,
    );

    let mut settings = get_settings(&app);
    settings.log_level = level;
    write_settings(&app, settings);

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_recordings_folder(app: AppHandle) -> Result<(), String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let recordings_dir = app_data_dir.join("recordings");

    let path = recordings_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open recordings folder: {}", e))?;

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_log_dir(app: AppHandle) -> Result<(), String> {
    let log_dir = crate::portable::app_log_dir(&app)
        .map_err(|e| format!("Failed to get log directory: {}", e))?;

    let path = log_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open log directory: {}", e))?;

    Ok(())
}

#[specta::specta]
#[tauri::command]
pub fn open_app_data_dir(app: AppHandle) -> Result<(), String> {
    let app_data_dir = crate::portable::app_data_dir(&app)
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    let path = app_data_dir.to_string_lossy().as_ref().to_string();
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| format!("Failed to open app data directory: {}", e))?;

    Ok(())
}

/// Check if Apple Intelligence is available on this device.
/// Called by the frontend when the user selects Apple Intelligence provider.
#[specta::specta]
#[tauri::command]
pub fn check_apple_intelligence_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        crate::apple_intelligence::check_apple_intelligence_availability()
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

/// Try to initialize Enigo (keyboard/mouse simulation).
/// On macOS, this will return an error if accessibility permissions are not granted.
#[specta::specta]
#[tauri::command]
pub fn initialize_enigo(app: AppHandle) -> Result<(), String> {
    use crate::input::EnigoState;

    // Check if already initialized
    if app.try_state::<EnigoState>().is_some() {
        log::debug!("Enigo already initialized");
        return Ok(());
    }

    // Try to initialize
    match EnigoState::new() {
        Ok(enigo_state) => {
            app.manage(enigo_state);
            log::info!("Enigo initialized successfully after permission grant");
            Ok(())
        }
        Err(e) => {
            if cfg!(target_os = "macos") {
                log::warn!(
                    "Failed to initialize Enigo: {} (accessibility permissions may not be granted)",
                    e
                );
            } else {
                log::warn!("Failed to initialize Enigo: {}", e);
            }
            Err(format!("Failed to initialize input system: {}", e))
        }
    }
}

/// Marker state to track if shortcuts have been initialized.
pub struct ShortcutsInitialized;

/// Initialize keyboard shortcuts.
/// On macOS, this should be called after accessibility permissions are granted.
/// This is idempotent - calling it multiple times is safe.
#[specta::specta]
#[tauri::command]
pub fn initialize_shortcuts(app: AppHandle) -> Result<(), String> {
    // Check if already initialized
    if app.try_state::<ShortcutsInitialized>().is_some() {
        log::debug!("Shortcuts already initialized");
        return Ok(());
    }

    // Initialize shortcuts
    crate::shortcut::init_shortcuts(&app);

    // Mark as initialized
    app.manage(ShortcutsInitialized);

    log::info!("Shortcuts initialized successfully");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_rest_api_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    let port = settings.rest_api_port;
    settings.rest_api_enabled = enabled;
    write_settings(&app, settings);

    if enabled {
        let api_app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::rest_api::start_server(api_app, port).await;
        });
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_rest_api_port(app: AppHandle, port: u16) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.rest_api_port = port;
    write_settings(&app, settings);
    Ok(())
}

/// Return the bundled EULA text and the current EULA version string. The
/// frontend compares the version against `eula_accepted_version` in settings
/// to decide whether to show the click-through modal.
#[tauri::command]
#[specta::specta]
pub fn get_eula(app: AppHandle) -> Result<(String, String), String> {
    let path = app
        .path()
        .resolve(
            "resources/legal/EULA.md",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve EULA path: {}", e))?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read EULA at {:?}: {}", path, e))?;
    Ok((text, crate::settings::CURRENT_EULA_VERSION.to_string()))
}

/// Return the bundled third-party notices text.
#[tauri::command]
#[specta::specta]
pub fn get_third_party_notices(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .resolve(
            "resources/legal/THIRD_PARTY_NOTICES.md",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve notices path: {}", e))?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read notices at {:?}: {}", path, e))
}

/// Mark the one-time IDE hint as seen for the given preset id. Idempotent.
#[tauri::command]
#[specta::specta]
pub fn mark_ide_hint_seen(app: AppHandle, preset_id: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    if !settings.seen_ide_hints.iter().any(|id| id == &preset_id) {
        settings.seen_ide_hints.push(preset_id);
        write_settings(&app, settings);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_ide_presets_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.ide_presets_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_ide_auto_submit(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.ide_auto_submit = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn reset_seen_ide_hints(app: AppHandle) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.seen_ide_hints.clear();
    write_settings(&app, settings);
    Ok(())
}

/// Record that the user has accepted the EULA at `version`. The app will not
/// prompt again until `CURRENT_EULA_VERSION` differs from the stored value.
#[tauri::command]
#[specta::specta]
pub fn accept_eula(app: AppHandle, version: String) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.eula_accepted_version = Some(version);
    write_settings(&app, settings);
    Ok(())
}
