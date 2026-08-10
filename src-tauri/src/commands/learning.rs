//! Tauri command surface for vocabulary learning.

use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::learning::{self, LearnedTerm};
use crate::managers::history::HistoryManager;

/// Seconds in the window the card reports on.
const WEEK: i64 = 7 * 86_400;

/// Terms Ghostly taught itself in the last week.
#[tauri::command]
#[specta::specta]
pub fn get_recently_learned(app: AppHandle) -> Result<Vec<LearnedTerm>, String> {
    let history = app
        .try_state::<Arc<HistoryManager>>()
        .ok_or("History is unavailable.")?
        .inner()
        .clone();
    let since = chrono::Utc::now().timestamp() - WEEK;
    history.recently_learned(since).map_err(|e| e.to_string())
}

/// Run a learning pass now instead of waiting for the daily one.
#[tauri::command]
#[specta::specta]
pub async fn run_learning_pass(app: AppHandle) -> Result<Vec<LearnedTerm>, String> {
    learning::run_pass(&app).await
}
