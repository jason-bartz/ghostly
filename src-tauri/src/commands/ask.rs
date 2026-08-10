//! Tauri command surface for "Ask your transcripts".

use tauri::AppHandle;

use crate::ask::{self, AskAnswer, AskBlocker, AskScope};

/// Answer a question from the user's own notes and meetings.
///
/// Errors are already user-facing strings — retrieval and entitlement failures
/// both surface here, and the pane shows them verbatim.
#[tauri::command]
#[specta::specta]
pub async fn ask_transcripts(
    app: AppHandle,
    question: String,
    scope: AskScope,
) -> Result<AskAnswer, String> {
    ask::ask(&app, &question, scope).await
}

/// Whether Ask can run, so the pane can offer the upgrade instead of a question
/// box it would refuse to answer.
#[tauri::command]
#[specta::specta]
pub fn ask_availability(app: AppHandle) -> AskBlocker {
    ask::availability(&app)
}

/// Write an answer to disk at a path the user picked in a save dialog.
///
/// The write happens here rather than in the webview because the frontend has
/// read-only filesystem capabilities — the same reason meeting exports are a
/// command.
#[tauri::command]
#[specta::specta]
pub fn export_ask_answer(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not write the file: {e}"))
}
