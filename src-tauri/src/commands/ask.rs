//! Tauri command surface for "Ask your transcripts".

use tauri::AppHandle;

use crate::ask::{self, AskAnswer};

/// Answer a question from the user's own notes and meetings.
///
/// Errors are already user-facing strings — retrieval and entitlement failures
/// both surface here, and the pane shows them verbatim.
#[tauri::command]
#[specta::specta]
pub async fn ask_transcripts(app: AppHandle, question: String) -> Result<AskAnswer, String> {
    ask::ask(&app, &question).await
}
