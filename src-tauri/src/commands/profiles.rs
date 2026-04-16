//! Tauri commands for per-app profile CRUD and voice-editing settings.

use crate::profiles::{self, AutoCleanupLevel, CategoryId, CategoryStyle, Profile, StyleId};
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

// ─────────────────────────────────────────────────────────────────────────────
// Style + Category commands (new)
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn set_style_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.style_enabled = enabled;
    write_settings(&app, settings);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_category_styles(app: AppHandle) -> Result<Vec<CategoryStyle>, String> {
    Ok(get_settings(&app).category_styles)
}

fn upsert_category<F: FnOnce(&mut CategoryStyle)>(
    app: &AppHandle,
    category: CategoryId,
    mutate: F,
) -> Result<Vec<CategoryStyle>, String> {
    let mut settings = get_settings(app);
    match settings
        .category_styles
        .iter_mut()
        .find(|cs| cs.category_id == category)
    {
        Some(existing) => mutate(existing),
        None => {
            let defaults = profiles::default_category_styles();
            let mut base = defaults
                .into_iter()
                .find(|cs| cs.category_id == category)
                .ok_or_else(|| "Unknown category".to_string())?;
            mutate(&mut base);
            settings.category_styles.push(base);
        }
    }
    let out = settings.category_styles.clone();
    write_settings(app, settings);
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub fn set_category_style(
    app: AppHandle,
    category: CategoryId,
    style: StyleId,
) -> Result<Vec<CategoryStyle>, String> {
    upsert_category(&app, category, |cs| cs.selected_style = style)
}

#[tauri::command]
#[specta::specta]
pub fn set_category_custom_prompt(
    app: AppHandle,
    category: CategoryId,
    prompt: Option<String>,
) -> Result<Vec<CategoryStyle>, String> {
    upsert_category(&app, category, |cs| {
        cs.custom_style_prompt = prompt.filter(|s| !s.trim().is_empty());
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_category_custom_style_name(
    app: AppHandle,
    category: CategoryId,
    name: Option<String>,
) -> Result<Vec<CategoryStyle>, String> {
    upsert_category(&app, category, |cs| {
        cs.custom_style_name = name.filter(|s| !s.trim().is_empty());
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_category_vocab(
    app: AppHandle,
    category: CategoryId,
    words: Vec<String>,
) -> Result<Vec<CategoryStyle>, String> {
    upsert_category(&app, category, |cs| {
        // De-duplicate case-insensitively while preserving order.
        let mut seen = std::collections::HashSet::<String>::new();
        cs.custom_vocab = words
            .into_iter()
            .filter_map(|w| {
                let trimmed = w.trim().to_string();
                if trimmed.is_empty() {
                    return None;
                }
                let key = trimmed.to_ascii_lowercase();
                if seen.insert(key) {
                    Some(trimmed)
                } else {
                    None
                }
            })
            .collect();
    })
}

#[tauri::command]
#[specta::specta]
pub fn set_auto_cleanup_level(app: AppHandle, level: AutoCleanupLevel) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.auto_cleanup_level = level;
    write_settings(&app, settings);
    Ok(())
}

/// Update the per-word category tags. Passing an empty `categories` vector
/// removes the entry (word applies globally).
#[tauri::command]
#[specta::specta]
pub fn set_custom_word_categories(
    app: AppHandle,
    word: String,
    categories: Vec<CategoryId>,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    let key = word.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Err("Word is empty".into());
    }
    if categories.is_empty() {
        settings.custom_word_categories.remove(&key);
    } else {
        settings.custom_word_categories.insert(key, categories);
    }
    write_settings(&app, settings);
    Ok(())
}

/// Returns the list of built-in macOS bundle IDs for each Category. Used by
/// the frontend to render the "applies in" app-icon strip per category.
#[tauri::command]
#[specta::specta]
pub fn get_category_apps(category: CategoryId) -> Vec<String> {
    profiles::category_apps(category)
        .iter()
        .map(|s| s.to_string())
        .collect()
}
