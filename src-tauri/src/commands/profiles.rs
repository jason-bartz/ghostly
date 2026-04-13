//! Tauri commands for per-app profile CRUD and voice-editing settings.

use crate::profiles::{self, Profile};
use crate::settings::{get_settings, write_settings, VoiceEditReplaceStrategy};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub fn set_profiles_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.profiles_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_profiles(app: AppHandle) -> Result<Vec<Profile>, String> {
    Ok(get_settings(&app).profiles)
}

#[tauri::command]
#[specta::specta]
pub fn add_profile(app: AppHandle, profile: Profile) -> Result<Vec<Profile>, String> {
    let mut settings = get_settings(&app);
    if settings.profiles.iter().any(|p| p.id == profile.id) {
        return Err(format!("Profile with id '{}' already exists", profile.id));
    }
    settings.profiles.push(profile);
    let updated = settings.profiles.clone();
    write_settings(&app, settings);
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub fn update_profile(app: AppHandle, profile: Profile) -> Result<Vec<Profile>, String> {
    let mut settings = get_settings(&app);
    match settings.profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => return Err(format!("Profile with id '{}' not found", profile.id)),
    }
    let updated = settings.profiles.clone();
    write_settings(&app, settings);
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub fn delete_profile(app: AppHandle, id: String) -> Result<Vec<Profile>, String> {
    let mut settings = get_settings(&app);
    let before = settings.profiles.len();
    settings.profiles.retain(|p| p.id != id);
    if settings.profiles.len() == before {
        return Err(format!("Profile with id '{}' not found", id));
    }
    let updated = settings.profiles.clone();
    write_settings(&app, settings);
    Ok(updated)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_profiles(app: AppHandle, ordered_ids: Vec<String>) -> Result<Vec<Profile>, String> {
    let mut settings = get_settings(&app);
    let mut by_id: std::collections::HashMap<String, Profile> = settings
        .profiles
        .drain(..)
        .map(|p| (p.id.clone(), p))
        .collect();
    let mut reordered = Vec::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        if let Some(p) = by_id.remove(&id) {
            reordered.push(p);
        }
    }
    // Append any profiles the caller didn't list (defensive — never drop data).
    for (_, p) in by_id {
        reordered.push(p);
    }
    settings.profiles = reordered;
    let updated = settings.profiles.clone();
    write_settings(&app, settings);
    Ok(updated)
}

// --- Built-in profiles ---

#[tauri::command]
#[specta::specta]
pub fn get_builtin_profiles() -> Result<Vec<Profile>, String> {
    Ok(profiles::get_builtin_profiles())
}

#[tauri::command]
#[specta::specta]
pub fn set_builtin_profiles_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.builtin_profiles_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

// --- Voice-editing settings ---

#[tauri::command]
#[specta::specta]
pub fn set_voice_editing_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.voice_editing_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_voice_edit_prefix_detection(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.voice_edit_prefix_detection = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_voice_edit_replace_strategy(
    app: AppHandle,
    strategy: VoiceEditReplaceStrategy,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.voice_edit_replace_strategy = strategy;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_session_buffer_size(app: AppHandle, size: usize) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.session_buffer_size = size.clamp(1, 50);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_session_idle_timeout_secs(app: AppHandle, secs: u64) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.session_idle_timeout_secs = secs.clamp(10, 3600);
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_voice_edit_session(app: AppHandle) -> Result<(), String> {
    use crate::session::SessionBuffer;
    use std::sync::Arc;
    use tauri::Manager;
    if let Some(sb) = app.try_state::<Arc<SessionBuffer>>() {
        sb.clear();
    }
    Ok(())
}
