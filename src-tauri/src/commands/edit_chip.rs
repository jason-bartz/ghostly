//! `apply_edit_chip` — handles the click path for the edit-mode chip strip.
//!
//! When the user clicks a chip (Shorten / Lengthen / Fix grammar / Rephrase)
//! while the edit overlay is open, we:
//!   1. Cancel the nascent recording that was started by the edit shortcut.
//!   2. Read the focused field's text via Cmd+A → Cmd+C round-trip.
//!   3. Send it to the voice-edit LLM with the chip's canned instruction.
//!   4. Select-all + paste the revised text, replacing what was there.
//!   5. Restore the user's original clipboard.
//!
//! This is the Superhuman-style affordance — the voice path (record, speak
//! instruction, edit last transcript) still exists in parallel through the
//! normal voice-edit pipeline.

use crate::actions::voice_edit_via_llm;
use crate::clipboard::{paste_with_options, PasteOptions};
use crate::input::{send_copy, send_select_all, EnigoState};
use crate::managers::audio::AudioRecordingManager;
use crate::profiles;
use crate::settings::get_settings;
use crate::utils;
use log::{error, info, warn};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// How long to wait after Cmd+C before reading the clipboard. Short enough to
/// feel instant; long enough for most apps to actually update the pasteboard.
const CLIPBOARD_READ_DELAY_MS: u64 = 120;

fn instruction_for_chip(chip_id: &str) -> Option<&'static str> {
    match chip_id {
        "shorten" => Some(
            "Rewrite the text to be noticeably shorter while preserving the core meaning and tone.",
        ),
        "lengthen" => Some(
            "Rewrite the text to be more detailed and expanded while preserving the core meaning and tone.",
        ),
        "fix_grammar" => Some(
            "Fix any spelling, grammar, and punctuation errors. Do not change wording, meaning, or tone.",
        ),
        "rephrase" => Some(
            "Rephrase the text to be clearer and more natural while preserving the meaning and tone.",
        ),
        _ => None,
    }
}

fn fail(app: &AppHandle, message: impl Into<String>) {
    let msg = message.into();
    warn!("apply_edit_chip: {}", msg);
    // Reuse the existing post-process-failed channel so the frontend toast
    // surface works without adding a new event type.
    #[derive(Clone, serde::Serialize)]
    struct PostProcessFailedEvent {
        message: String,
    }
    let _ = app.emit(
        "post-process-failed",
        PostProcessFailedEvent { message: msg },
    );
    crate::overlay::emit_edit_chip_done(app);
    utils::hide_recording_overlay(app);
    crate::tray::change_tray_icon(app, crate::tray::TrayIconState::Idle);
}

#[tauri::command]
#[specta::specta]
pub async fn apply_edit_chip(app: AppHandle, chip_id: String) -> Result<(), String> {
    let instruction = match instruction_for_chip(&chip_id) {
        Some(i) => i,
        None => {
            fail(&app, format!("Unknown edit chip: {}", chip_id));
            return Err(format!("Unknown edit chip: {}", chip_id));
        }
    };

    info!(
        "apply_edit_chip: chip={} instruction={}",
        chip_id, instruction
    );

    // Cancel the recording started by the edit shortcut. We do this inline
    // instead of calling `cancel_current_operation` so the overlay stays
    // visible for the chip's processing state.
    if let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() {
        audio.cancel_recording();
    }
    crate::shortcut::unregister_cancel_shortcut(&app);
    if let Some(sc) = app.try_state::<Arc<crate::stream_cancel::StreamCancellation>>() {
        sc.reset();
    }
    if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
        coord.notify_cancel(true);
    }

    // Intentionally do NOT call show_processing_overlay here — the overlay is
    // already in edit-mode and the clicked chip pulses as its own "working"
    // indicator. Swapping to the compact processing state would snap the
    // panel width and hide which chip the user chose.
    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Transcribing);

    // Save the user's clipboard so we can restore it once we're done
    // pretending to use it as a conveyor belt.
    let clipboard = app.clipboard();
    let saved_clipboard = clipboard.read_text().unwrap_or_default();

    // Read focused field: Cmd+A → Cmd+C → read pasteboard.
    let original_text = {
        let enigo_state = app
            .try_state::<EnigoState>()
            .ok_or_else(|| "Enigo state not initialized".to_string())?;
        let mut enigo = enigo_state
            .0
            .lock()
            .map_err(|e| format!("Failed to lock Enigo: {}", e))?;

        // Clear the clipboard first so we can tell the difference between
        // "Cmd+C actually copied something" and "the field was empty or not
        // focusable." Otherwise a stale clipboard would look like success.
        let _ = clipboard.write_text("");
        std::thread::sleep(Duration::from_millis(20));

        send_select_all(&mut enigo).map_err(|e| {
            fail(
                &app,
                format!("Couldn't select text in focused field: {}", e),
            );
            e
        })?;
        std::thread::sleep(Duration::from_millis(40));
        send_copy(&mut enigo).map_err(|e| {
            fail(
                &app,
                format!("Couldn't copy text from focused field: {}", e),
            );
            e
        })?;
        drop(enigo);

        std::thread::sleep(Duration::from_millis(CLIPBOARD_READ_DELAY_MS));
        clipboard.read_text().unwrap_or_default()
    };

    if original_text.trim().is_empty() {
        let _ = clipboard.write_text(&saved_clipboard);
        fail(
            &app,
            "No text in the focused field. Click into a text field with content first.",
        );
        return Err("No text in focused field".to_string());
    }

    info!(
        "apply_edit_chip: read {} chars from focused field",
        original_text.chars().count()
    );

    let settings = get_settings(&app);
    let app_ctx = crate::frontmost::current().ok().flatten();
    let overrides = profiles::resolve_with_builtins(&settings, app_ctx.as_ref());

    // Early guards: must have an LLM configured.
    if !settings.has_working_llm() {
        let _ = clipboard.write_text(&saved_clipboard);
        fail(
            &app,
            "No AI provider configured. Set one up in Settings → AI Refinement.",
        );
        return Err("No LLM configured".to_string());
    }

    let revised = match voice_edit_via_llm(&settings, &original_text, instruction, &overrides).await
    {
        Some(t) => t,
        None => {
            let _ = clipboard.write_text(&saved_clipboard);
            fail(&app, "AI refinement returned nothing. Please try again.");
            return Err("LLM returned no content".to_string());
        }
    };

    // Paste the revised text over a fresh select-all so we replace whatever
    // the user had. The paste helper writes to the clipboard; we restore the
    // user's original clipboard afterwards.
    let paste_result: Result<(), String> = {
        let enigo_state = app
            .try_state::<EnigoState>()
            .ok_or_else(|| "Enigo state not initialized".to_string())?;
        // Select-all must happen outside the paste helper's Enigo lock.
        {
            let mut enigo = enigo_state
                .0
                .lock()
                .map_err(|e| format!("Failed to lock Enigo: {}", e))?;
            send_select_all(&mut enigo)?;
        }
        std::thread::sleep(Duration::from_millis(40));

        let opts = PasteOptions {
            append_trailing_space: Some(false),
            replace_prior_chars: None,
            suppress_auto_submit: true,
        };
        paste_with_options(revised, app.clone(), opts)
    };

    // Always restore the user's clipboard, even on paste failure.
    std::thread::sleep(Duration::from_millis(60));
    let _ = clipboard.write_text(&saved_clipboard);

    match paste_result {
        Ok(()) => {
            info!("apply_edit_chip: paste completed");
            crate::overlay::emit_edit_chip_done(&app);
            utils::hide_recording_overlay(&app);
            crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Idle);
            Ok(())
        }
        Err(e) => {
            error!("apply_edit_chip: paste failed: {}", e);
            fail(&app, format!("Couldn't paste revised text: {}", e));
            Err(e)
        }
    }
}
