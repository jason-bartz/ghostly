//! Tauri command surface for encrypted sync.
//!
//! Every command returns a user-facing string on failure; the sync pane shows
//! them verbatim, because "that passphrase doesn't match this account" is more
//! useful than any code the UI could map.

use tauri::AppHandle;

use crate::sync::engine::{self, SyncOutcome, SyncStatus};

#[tauri::command]
#[specta::specta]
pub fn sync_status(app: AppHandle) -> SyncStatus {
    engine::status(&app)
}

/// Turn sync on for an account that has never had it.
#[tauri::command]
#[specta::specta]
pub async fn sync_setup(app: AppHandle, passphrase: String) -> Result<(), String> {
    engine::setup(&app, &passphrase).await
}

/// Join an account that already syncs, from another Mac.
#[tauri::command]
#[specta::specta]
pub async fn sync_unlock(app: AppHandle, passphrase: String) -> Result<(), String> {
    engine::unlock(&app, &passphrase).await
}

#[tauri::command]
#[specta::specta]
pub async fn sync_now(app: AppHandle) -> Result<SyncOutcome, String> {
    engine::run(&app).await
}

/// Stop syncing this Mac. Local data is untouched.
#[tauri::command]
#[specta::specta]
pub fn sync_disable(app: AppHandle) {
    engine::disable(&app)
}

/// Erase the account's synced copy everywhere. Local data is untouched.
#[tauri::command]
#[specta::specta]
pub async fn sync_reset(app: AppHandle) -> Result<(), String> {
    engine::reset(&app).await
}
