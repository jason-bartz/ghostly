use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::managers::usage::{UsageManager, UsageStats};
use crate::settings::get_settings;

#[tauri::command]
#[specta::specta]
pub fn get_usage_stats(app: AppHandle) -> Result<UsageStats, String> {
    let settings = get_settings(&app);
    let manager = app.state::<Arc<UsageManager>>();
    Ok(manager.stats(settings.effective_is_pro()))
}

/// Debug-only: flip the free-tier override so devs can exercise the paywall
/// without carrying a real license. No-op on `effective_is_pro()` when
/// `is_pro` is already false.
#[tauri::command]
#[specta::specta]
pub fn set_dev_force_free_tier(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.dev_force_free_tier = enabled;
    crate::settings::write_settings(&app, settings);
    Ok(())
}

/// Debug-only: flip the local `is_pro` flag. Once the real license flow
/// ships this will be replaced by a validated license key path; for now it
/// lets us test the Pro UI state without payment.
#[tauri::command]
#[specta::specta]
pub fn set_dev_is_pro(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.is_pro = enabled;
    crate::settings::write_settings(&app, settings);
    Ok(())
}
