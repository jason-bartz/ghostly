//! Shared shortcut event handling logic
//!
//! This module contains the common logic for handling shortcut events,
//! used by both the Tauri and handy-keys implementations.

use log::warn;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

use crate::actions::ACTION_MAP;
use crate::managers::audio::AudioRecordingManager;
use crate::settings::get_settings;
use crate::transcription_coordinator::is_transcribe_binding;
use crate::TranscriptionCoordinator;

/// Handle a shortcut event from either implementation.
///
/// This function contains the shared logic for:
/// - Looking up the action in ACTION_MAP
/// - Handling the cancel binding (only fires when recording)
/// - Handling push-to-talk mode (start on press, stop on release)
/// - Handling toggle mode (toggle state on press only)
///
/// # Arguments
/// * `app` - The Tauri app handle
/// * `binding_id` - The ID of the binding (e.g., "transcribe", "cancel")
/// * `hotkey_string` - The string representation of the hotkey
/// * `is_pressed` - Whether this is a key press (true) or release (false)
pub fn handle_shortcut_event(
    app: &AppHandle,
    binding_id: &str,
    hotkey_string: &str,
    is_pressed: bool,
) {
    let settings = get_settings(app);

    // Transcribe bindings (including prompt shortcuts) are handled by the coordinator.
    if is_transcribe_binding(binding_id) {
        if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
            coordinator.send_input(binding_id, hotkey_string, is_pressed, settings.push_to_talk);
        } else {
            warn!("TranscriptionCoordinator is not initialized");
        }
        return;
    }

    // Continuous dictation arm/disarm: toggle on key press only.
    // Not backed by ACTION_MAP — dispatch before the lookup.
    if binding_id == "toggle_continuous_dictation" {
        if is_pressed {
            if let Some(cm) =
                app.try_state::<Arc<crate::managers::continuous::ContinuousDictationManager>>()
            {
                cm.toggle();
            } else {
                warn!("Continuous dictation manager not available");
            }
        }
        return;
    }

    // Meeting capture start/stop. Like continuous dictation this is not backed
    // by ACTION_MAP, because it has no press/release lifecycle.
    if binding_id == "toggle_meeting" {
        if is_pressed {
            if let Some(manager) = app.try_state::<Arc<crate::meetings::MeetingManager>>() {
                let manager = Arc::clone(&manager);
                // Off-thread: bringing up the system-audio tap blocks, and this
                // handler runs on the shortcut dispatch thread.
                std::thread::spawn(move || {
                    if manager.is_capturing() {
                        manager.stop();
                    } else if let Err(e) = manager.start(
                        crate::meetings::types::DetectionSource::Manual,
                        crate::app_identity::frontmost_bundle_id(),
                        crate::app_identity::frontmost_display_name(),
                        None,
                    ) {
                        warn!("Could not start meeting capture: {e}");
                    }
                });
            } else {
                warn!("Meeting manager not available");
            }
        }
        return;
    }

    // "Catch me up" on the active meeting.
    if binding_id == "meeting_catch_up" {
        if is_pressed {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(manager) = app.try_state::<Arc<crate::meetings::MeetingManager>>() else {
                    return;
                };
                let Some(meeting_id) = manager.active_meeting_id() else {
                    return;
                };
                // Surface the panel so the summary has somewhere to land.
                crate::meetings::panel::show(&app);
                let from_ms = manager.store().last_summarised_ms(&meeting_id).unwrap_or(0);
                match crate::meetings::summarizer::summarize_window(
                    &app,
                    manager.store(),
                    &meeting_id,
                    from_ms,
                    i64::MAX,
                    crate::meetings::types::SummaryKind::CatchUp,
                )
                .await
                {
                    Ok(body) => {
                        let _ = app.emit("meeting-catch-up", body);
                    }
                    Err(e) => warn!("Catch me up failed: {e}"),
                }
            });
        }
        return;
    }

    let Some(action) = ACTION_MAP.get(binding_id) else {
        warn!(
            "No action defined in ACTION_MAP for shortcut ID '{}'. Shortcut: '{}', Pressed: {}",
            binding_id, hotkey_string, is_pressed
        );
        return;
    };

    // Cancel binding: only fires when recording and key is pressed
    if binding_id == "cancel" {
        let audio_manager = app.state::<Arc<AudioRecordingManager>>();
        if audio_manager.is_recording() && is_pressed {
            action.start(app, binding_id, hotkey_string);
        }
        return;
    }

    // Remaining bindings (e.g. "test") use simple start/stop on press/release.
    if is_pressed {
        action.start(app, binding_id, hotkey_string);
    } else {
        action.stop(app, binding_id, hotkey_string);
    }
}
