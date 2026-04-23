use crate::audio_toolkit::list_input_devices;
use crate::managers::history::{HistoryEntry, HistoryManager};
use crate::managers::model::ModelManager;
use crate::managers::transcription::TranscriptionManager;
use crate::managers::usage::UsageManager;
use crate::settings;
use crate::tray_i18n::get_tray_translations;
use log::{error, info, warn};
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, Theme};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Clone, Debug, PartialEq)]
pub enum TrayIconState {
    Idle,
    Recording,
    Transcribing,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppTheme {
    Dark,
    Light,
    Colored, // Pink/colored theme for Linux
}

/// Gets the current app theme, with Linux defaulting to Colored theme
pub fn get_current_theme(app: &AppHandle) -> AppTheme {
    if cfg!(target_os = "linux") {
        // On Linux, always use the colored theme
        AppTheme::Colored
    } else {
        // On other platforms, map system theme to our app theme
        if let Some(main_window) = app.get_webview_window("main") {
            match main_window.theme().unwrap_or(Theme::Dark) {
                Theme::Light => AppTheme::Light,
                Theme::Dark => AppTheme::Dark,
                _ => AppTheme::Dark, // Default fallback
            }
        } else {
            AppTheme::Dark
        }
    }
}

/// Gets the appropriate icon path for the given theme and state
pub fn get_icon_path(theme: AppTheme, state: TrayIconState) -> &'static str {
    match (theme, state) {
        // Dark theme uses light icons
        (AppTheme::Dark, TrayIconState::Idle) => "resources/tray_idle.png",
        (AppTheme::Dark, TrayIconState::Recording) => "resources/tray_recording.png",
        (AppTheme::Dark, TrayIconState::Transcribing) => "resources/tray_transcribing.png",
        // Light theme uses dark icons
        (AppTheme::Light, TrayIconState::Idle) => "resources/tray_idle_dark.png",
        (AppTheme::Light, TrayIconState::Recording) => "resources/tray_recording_dark.png",
        (AppTheme::Light, TrayIconState::Transcribing) => "resources/tray_transcribing_dark.png",
        // Colored theme uses pink icons (for Linux)
        (AppTheme::Colored, TrayIconState::Idle) => "resources/ghostly.png",
        (AppTheme::Colored, TrayIconState::Recording) => "resources/recording.png",
        (AppTheme::Colored, TrayIconState::Transcribing) => "resources/transcribing.png",
    }
}

pub fn change_tray_icon(app: &AppHandle, icon: TrayIconState) {
    let tray = app.state::<TrayIcon>();
    let theme = get_current_theme(app);
    let icon_path = get_icon_path(theme, icon.clone());

    match app
        .path()
        .resolve(icon_path, tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())
        .and_then(|p| Image::from_path(p).map_err(|e| e.to_string()))
    {
        Ok(image) => {
            if let Err(e) = tray.set_icon(Some(image)) {
                error!("Failed to set tray icon: {}", e);
            }
        }
        Err(e) => error!("Failed to load tray icon '{}': {}", icon_path, e),
    }

    update_tray_menu(app, &icon, None);
}

pub fn tray_tooltip() -> String {
    version_label()
}

fn version_label() -> String {
    if cfg!(debug_assertions) {
        format!("Ghostly v{} (Dev)", env!("CARGO_PKG_VERSION"))
    } else {
        format!("Ghostly v{}", env!("CARGO_PKG_VERSION"))
    }
}

pub fn update_tray_menu(app: &AppHandle, state: &TrayIconState, locale: Option<&str>) {
    let version_label = version_label();
    match build_tray_menu(app, state, locale) {
        Ok(menu) => {
            let tray = app.state::<TrayIcon>();
            let _ = tray.set_menu(Some(menu));
            let _ = tray.set_icon_as_template(true);
            let _ = tray.set_tooltip(Some(version_label));
        }
        Err(e) => error!("Failed to rebuild tray menu: {}", e),
    }
}

fn build_tray_menu(
    app: &AppHandle,
    state: &TrayIconState,
    locale: Option<&str>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = settings::get_settings(app);
    let locale = locale.unwrap_or(&settings.app_language);
    let strings = get_tray_translations(Some(locale.to_string()));

    #[cfg(target_os = "macos")]
    let (settings_accelerator, quit_accelerator) = (Some("Cmd+,"), Some("Cmd+Q"));
    #[cfg(not(target_os = "macos"))]
    let (settings_accelerator, quit_accelerator) = (Some("Ctrl+,"), Some("Ctrl+Q"));

    let version_label = version_label();
    let version_i = MenuItem::with_id(app, "version", &version_label, false, None::<&str>)?;
    let metrics_label = weekly_metrics_label(app);
    let metrics_i = MenuItem::with_id(app, "metrics", &metrics_label, false, None::<&str>)?;
    let settings_i = MenuItem::with_id(
        app,
        "settings",
        &strings.settings,
        true,
        settings_accelerator,
    )?;
    let copy_last_transcript_i = MenuItem::with_id(
        app,
        "copy_last_transcript",
        &strings.copy_last_transcript,
        true,
        None::<&str>,
    )?;
    let model_loaded = app.state::<Arc<TranscriptionManager>>().is_model_loaded();
    let quit_i = MenuItem::with_id(app, "quit", &strings.quit, true, quit_accelerator)?;

    let model_manager = app.state::<Arc<ModelManager>>();
    let models = model_manager.get_available_models();
    let current_model_id = &settings.selected_model;

    let mut downloaded: Vec<_> = models.into_iter().filter(|m| m.is_downloaded).collect();
    downloaded.sort_by(|a, b| a.name.cmp(&b.name));

    let submenu_label = downloaded
        .iter()
        .find(|m| m.id == *current_model_id)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| strings.model.clone());

    let model_submenu = Submenu::with_id(app, "model_submenu", &submenu_label, true)?;
    for model in &downloaded {
        let is_active = model.id == *current_model_id;
        let item_id = format!("model_select:{}", model.id);
        let item =
            CheckMenuItem::with_id(app, &item_id, &model.name, true, is_active, None::<&str>)?;
        let _ = model_submenu.append(&item);
    }

    let unload_model_i = MenuItem::with_id(
        app,
        "unload_model",
        &strings.unload_model,
        model_loaded,
        None::<&str>,
    )?;

    let current_mic = settings.selected_microphone.clone();
    let devices = list_input_devices().unwrap_or_default();
    let mic_submenu_label = current_mic
        .as_deref()
        .and_then(|name| devices.iter().find(|d| d.name == name))
        .map(|d| d.name.clone())
        .unwrap_or_else(|| strings.microphone.clone());
    let mic_submenu = Submenu::with_id(app, "mic_submenu", &mic_submenu_label, true)?;
    let default_item = CheckMenuItem::with_id(
        app,
        "mic_select:default",
        &strings.default_microphone,
        true,
        current_mic.is_none(),
        None::<&str>,
    )?;
    let _ = mic_submenu.append(&default_item);
    for device in &devices {
        let is_active = current_mic.as_deref() == Some(device.name.as_str());
        let item_id = format!("mic_select:{}", device.name);
        let item =
            CheckMenuItem::with_id(app, &item_id, &device.name, true, is_active, None::<&str>)?;
        let _ = mic_submenu.append(&item);
    }

    let sep = || PredefinedMenuItem::separator(app);

    match state {
        TrayIconState::Recording | TrayIconState::Transcribing => {
            let cancel_i = MenuItem::with_id(app, "cancel", &strings.cancel, true, None::<&str>)?;
            Menu::with_items(
                app,
                &[
                    &version_i,
                    &metrics_i,
                    &sep()?,
                    &cancel_i,
                    &sep()?,
                    &copy_last_transcript_i,
                    &sep()?,
                    &settings_i,
                    &sep()?,
                    &quit_i,
                ],
            )
        }
        TrayIconState::Idle => Menu::with_items(
            app,
            &[
                &version_i,
                &metrics_i,
                &sep()?,
                &copy_last_transcript_i,
                &sep()?,
                &model_submenu,
                &unload_model_i,
                &sep()?,
                &mic_submenu,
                &sep()?,
                &settings_i,
                &sep()?,
                &quit_i,
            ],
        ),
    }
}

/// Short one-line summary of this week's vanity metrics for the tray menu.
/// macOS tray menus can't render UI, so we pack into one line.
fn weekly_metrics_label(app: &AppHandle) -> String {
    let Some(um) = app.try_state::<Arc<UsageManager>>() else {
        return "— this week".to_string();
    };
    let settings = settings::get_settings(app);
    let stats = um.stats(settings.effective_is_pro());
    let minutes_saved = stats.time_saved_secs_this_week / 60;
    let words = format_thousands(stats.words_this_week);
    if stats.words_this_week == 0 {
        "No activity this week".to_string()
    } else if minutes_saved == 0 {
        format!("{} words this week", words)
    } else {
        format!("{} words · {} min saved this week", words, minutes_saved)
    }
}

fn format_thousands(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

fn last_transcript_text(entry: &HistoryEntry) -> &str {
    entry
        .post_processed_text
        .as_deref()
        .unwrap_or(&entry.transcription_text)
}

pub fn set_tray_visibility(app: &AppHandle, visible: bool) {
    let tray = app.state::<TrayIcon>();
    if let Err(e) = tray.set_visible(visible) {
        error!("Failed to set tray visibility: {}", e);
    } else {
        info!("Tray visibility set to: {}", visible);
    }
}

pub fn copy_last_transcript(app: &AppHandle) {
    let history_manager = app.state::<Arc<HistoryManager>>();
    let entry = match history_manager.get_latest_completed_entry() {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            warn!("No completed transcription history entries available for tray copy.");
            return;
        }
        Err(err) => {
            error!(
                "Failed to fetch last completed transcription entry: {}",
                err
            );
            return;
        }
    };

    let text = last_transcript_text(&entry);
    if text.trim().is_empty() {
        warn!("Last completed transcription is empty; skipping tray copy.");
        return;
    }

    if let Err(err) = app.clipboard().write_text(text) {
        error!("Failed to copy last transcript to clipboard: {}", err);
        return;
    }

    info!("Copied last transcript to clipboard via tray.");
}

#[cfg(test)]
mod tests {
    use super::last_transcript_text;
    use crate::managers::history::HistoryEntry;

    fn build_entry(transcription: &str, post_processed: Option<&str>) -> HistoryEntry {
        HistoryEntry {
            id: 1,
            file_name: "ghostly-1.wav".to_string(),
            timestamp: 0,
            saved: false,
            title: "Recording".to_string(),
            user_title: None,
            transcription_text: transcription.to_string(),
            post_processed_text: post_processed.map(|text| text.to_string()),
            tags: Vec::new(),
            post_process_prompt: None,
            post_process_requested: false,
            source_app: None,
        }
    }

    #[test]
    fn uses_post_processed_text_when_available() {
        let entry = build_entry("raw", Some("processed"));
        assert_eq!(last_transcript_text(&entry), "processed");
    }

    #[test]
    fn falls_back_to_raw_transcription() {
        let entry = build_entry("raw", None);
        assert_eq!(last_transcript_text(&entry), "raw");
    }
}
