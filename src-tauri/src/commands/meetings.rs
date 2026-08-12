//! Commands backing Meeting Mode.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::meetings::detector::MeetingDetector;
use crate::meetings::summarizer;
use crate::meetings::types::{
    DetectionSource, Meeting, MeetingNotes, MeetingSegment, MeetingSpeaker, MeetingStatus,
    MeetingSummary, SummaryKind,
};
use crate::meetings::MeetingManager;
use crate::settings::{get_settings, write_settings, MeetingSettings};
use crate::{app_identity, system_audio};

/// Whether this machine can capture the far side of a meeting, and why not.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioCapability {
    /// CoreAudio process taps are available (macOS 14.2+).
    pub supported: bool,
    /// Capture is active right now.
    pub running: bool,
    /// Native tap rate while running, for diagnostics.
    pub sample_rate: Option<f64>,
    /// User-facing explanation when `supported` is false.
    pub unavailable_reason: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn get_system_audio_capability() -> SystemAudioCapability {
    let supported = system_audio::is_supported();
    SystemAudioCapability {
        supported,
        running: system_audio::is_running(),
        sample_rate: system_audio::native_sample_rate(),
        unavailable_reason: (!supported).then(|| {
            "Capturing the other side of a meeting needs macOS 14.2 or later. Ghostly can still \
             transcribe your own microphone."
                .to_string()
        }),
    }
}

/// A running application, reported with its genuine bundle identifier.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunningAppInfo {
    pub bundle_id: String,
    pub display_name: String,
}

/// Running applications with real bundle identifiers.
///
/// Note this is *not* the same as [`crate::frontmost::detect_frontmost_app`],
/// whose `bundleId` field actually carries a Core Graphics owner name. See
/// [`crate::app_identity`] for the details.
#[tauri::command]
#[specta::specta]
pub fn list_running_apps() -> Vec<RunningAppInfo> {
    app_identity::running_apps()
        .into_iter()
        .map(|app| RunningAppInfo {
            bundle_id: app.bundle_id,
            display_name: app.display_name,
        })
        .collect()
}

/// Genuine bundle identifier of the frontmost application.
#[tauri::command]
#[specta::specta]
pub fn detect_frontmost_bundle_id() -> Option<String> {
    app_identity::frontmost_bundle_id()
}

// ---- Settings ------------------------------------------------------------

/// What the "Automatic" AI choice currently resolves to.
///
/// "Automatic" that will not say what it picked is not a setting, it is a
/// shrug — and here the answer decides whether meeting text leaves the Mac, so
/// it has to be on screen rather than inferred.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingAiResolution {
    /// True when Automatic routes to the configured cloud provider.
    pub uses_cloud: bool,
    /// Display name of the provider it resolves to, for the UI to name.
    pub provider_name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_ai_resolution(app: AppHandle) -> MeetingAiResolution {
    let settings = get_settings(&app);
    let uses_cloud = settings.has_usable_cloud_ai();
    MeetingAiResolution {
        uses_cloud,
        provider_name: uses_cloud
            .then(|| settings.active_post_process_provider())
            .flatten()
            .map(|provider| provider.label.clone()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_settings(app: AppHandle) -> MeetingSettings {
    get_settings(&app).meeting
}

#[tauri::command]
#[specta::specta]
pub fn update_meeting_settings(app: AppHandle, settings: MeetingSettings) -> Result<(), String> {
    let mut current = get_settings(&app);
    current.meeting = settings;
    write_settings(&app, current);
    Ok(())
}

// ---- Capture -------------------------------------------------------------

fn manager(app: &AppHandle) -> Result<Arc<MeetingManager>, String> {
    app.try_state::<Arc<MeetingManager>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| "Meeting Mode is unavailable.".to_string())
}

/// Starts capturing, always as a fresh session.
///
/// If a capture is somehow still running — an end that failed, a session the
/// user forgot about — it is ended first rather than refused. "Start" that
/// errors with "a meeting is already being captured" and leaves the previous
/// transcript on screen is indistinguishable from a stuck app.
///
/// Runs on a blocking thread because bringing up the system-audio tap can stall
/// for several seconds the first time in a process.
#[tauri::command]
#[specta::specta]
pub async fn start_meeting(app: AppHandle, title: Option<String>) -> Result<String, String> {
    let bundle_id = app_identity::frontmost_bundle_id();
    let display_name = app_identity::frontmost_display_name();
    let manager = manager(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        if manager.is_capturing() {
            manager.stop();
        }
        manager.start(DetectionSource::Manual, bundle_id, display_name, title)
    })
    .await
    .map_err(|e| format!("Could not start the meeting: {e}"))?
}

/// Accepts a detected meeting, starting capture immediately.
#[tauri::command]
#[specta::specta]
pub async fn accept_detected_meeting(app: AppHandle) -> Result<String, String> {
    let detector = app
        .try_state::<Arc<MeetingDetector>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(|| "Meeting detection is unavailable.".to_string())?;
    let detected = detector
        .pending()
        .ok_or_else(|| "There is no detected meeting to join.".to_string())?;
    detector.cancel_pending();

    let manager = manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let title = detected.meeting_title();
        manager.start(
            DetectionSource::Prompted,
            Some(detected.bundle_id.clone()),
            Some(detected.display_name.clone()),
            Some(title),
        )
    })
    .await
    .map_err(|e| format!("Could not start the meeting: {e}"))?
}

/// Dismisses a prompt or cancels a running countdown.
#[tauri::command]
#[specta::specta]
pub fn dismiss_detected_meeting(app: AppHandle) {
    if let Some(detector) = app.try_state::<Arc<MeetingDetector>>() {
        detector.cancel_pending();
    }
}

/// Never auto-connect for this app again.
#[tauri::command]
#[specta::specta]
pub fn never_auto_connect_app(
    app: AppHandle,
    bundle_id: String,
    display_name: String,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    let policy = crate::settings::MeetingAppPolicy {
        bundle_id: bundle_id.clone(),
        display_name,
        policy: crate::settings::MeetingAutoConnect::Off,
    };
    match settings
        .meeting
        .app_policies
        .iter_mut()
        .find(|p| p.bundle_id.eq_ignore_ascii_case(&bundle_id))
    {
        Some(existing) => existing.policy = crate::settings::MeetingAutoConnect::Off,
        None => settings.meeting.app_policies.push(policy),
    }
    write_settings(&app, settings);
    dismiss_detected_meeting(app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_meeting(app: AppHandle) -> Result<Option<String>, String> {
    let manager = manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || manager.stop())
        .await
        .map_err(|e| format!("Could not stop the meeting: {e}"))
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_status(app: AppHandle) -> MeetingStatus {
    match app.try_state::<Arc<MeetingManager>>() {
        Some(manager) => manager.status(),
        None => MeetingStatus::default(),
    }
}

// ---- Transcript ----------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn list_meetings(app: AppHandle, limit: Option<i64>) -> Result<Vec<Meeting>, String> {
    manager(&app)?
        .store()
        .list_meetings(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting(app: AppHandle, meeting_id: String) -> Result<Option<Meeting>, String> {
    manager(&app)?
        .store()
        .get_meeting(&meeting_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_segments(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<MeetingSegment>, String> {
    manager(&app)?
        .store()
        .list_segments(&meeting_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_speakers(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<MeetingSpeaker>, String> {
    manager(&app)?
        .store()
        .list_speakers(&meeting_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn delete_meeting(app: AppHandle, meeting_id: String) -> Result<(), String> {
    manager(&app)?
        .store()
        .delete_meeting(&meeting_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_meeting_title(app: AppHandle, meeting_id: String, title: String) -> Result<(), String> {
    let manager = manager(&app)?;
    manager
        .store()
        .set_meeting_title(&meeting_id, &title)
        .map_err(|e| e.to_string())?;
    // Keeps the live panel's header in step when the meeting being renamed is
    // the one currently being captured.
    let trimmed = title.trim();
    manager.rename_active(
        &meeting_id,
        (!trimmed.is_empty()).then(|| trimmed.to_string()),
    );
    Ok(())
}

/// Corrects one transcript line by hand.
///
/// ASR gets names and jargon wrong, and live AI cleanup only narrows that — it
/// never closes it. A transcript people export and send on needs a way to fix
/// the last few errors.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_segment_text(
    app: AppHandle,
    segment_id: i64,
    text: String,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("A transcript line cannot be empty.".to_string());
    }
    manager(&app)?
        .store()
        .update_segment_text(segment_id, trimmed)
        .map_err(|e| e.to_string())
}

/// Transcript as plain paragraphs, for copy/export. Matches what is on screen.
#[tauri::command]
#[specta::specta]
pub fn export_meeting_transcript(app: AppHandle, meeting_id: String) -> Result<String, String> {
    let store = manager(&app)?;
    let store = store.store();
    let segments = store
        .list_segments(&meeting_id)
        .map_err(|e| e.to_string())?;
    Ok(summarizer::render_transcript_plain(&segments))
}

// ---- Speakers ------------------------------------------------------------
//
// Naming, merging, adding and reassigning speakers are gone. Ghostly has no
// speaker-embedding model, so attribution was never better than "which lane did
// this arrive on" — two rows per meeting, "You" and "Participant" — and the
// editing UI existed to repair a guess the product could not make well in the
// first place. A transcript that does not claim to know who spoke needs no
// controls for correcting the claim.
//
// The rows themselves stay. [`summarizer::render_transcript`] still feeds
// lane-derived names to the summariser, which is where knowing who committed to
// what genuinely pays off, and `get_meeting_speakers` still reads them back.

// ---- Summaries -----------------------------------------------------------

/// Shortest window "catch me up" will ever summarise.
///
/// Three minutes is roughly what someone misses by looking away, and it is long
/// enough that the answer is a paragraph rather than a sentence fragment.
const MIN_CATCH_UP_WINDOW_MS: i64 = 3 * 60 * 1000;

/// "Catch me up" — summarises everything since the last summary.
#[tauri::command]
#[specta::specta]
pub async fn catch_me_up(app: AppHandle, meeting_id: Option<String>) -> Result<String, String> {
    let manager = manager(&app)?;
    let meeting_id = meeting_id
        .or_else(|| manager.active_meeting_id())
        .ok_or_else(|| "No meeting is being captured.".to_string())?;

    // "Since I last caught up" is the useful default; a fixed five-minute
    // window either repeats what you already read or misses the gap.
    //
    // But rolling summaries run in the background and keep pushing that mark
    // forward, so pressing the button shortly after one lands would summarise
    // the twenty seconds since — technically correct and useless. The floor
    // guarantees there is always something worth reading.
    let last_summarised = manager.store().last_summarised_ms(&meeting_id).unwrap_or(0);
    let floor = (manager.elapsed_ms() - MIN_CATCH_UP_WINDOW_MS).max(0);
    let from_ms = last_summarised.min(floor);
    let to_ms = i64::MAX;

    summarizer::summarize_window(
        &app,
        manager.store(),
        &meeting_id,
        from_ms,
        to_ms,
        SummaryKind::CatchUp,
    )
    .await
}

/// Summarises an explicit window, in minutes back from now.
#[tauri::command]
#[specta::specta]
pub async fn summarize_meeting_window(
    app: AppHandle,
    meeting_id: String,
    minutes: u32,
) -> Result<String, String> {
    let manager = manager(&app)?;
    let elapsed = manager.elapsed_ms();
    let from_ms = (elapsed - (minutes as i64 * 60_000)).max(0);

    summarizer::summarize_window(
        &app,
        manager.store(),
        &meeting_id,
        from_ms,
        i64::MAX,
        SummaryKind::CatchUp,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub fn get_meeting_summaries(
    app: AppHandle,
    meeting_id: String,
) -> Result<Vec<MeetingSummary>, String> {
    manager(&app)?
        .store()
        .list_summaries(&meeting_id)
        .map_err(|e| e.to_string())
}

/// End-of-meeting wrap-up over the whole transcript.
#[tauri::command]
#[specta::specta]
pub async fn summarize_meeting(app: AppHandle, meeting_id: String) -> Result<String, String> {
    let manager = manager(&app)?;
    summarizer::summarize_window(
        &app,
        manager.store(),
        &meeting_id,
        0,
        i64::MAX,
        SummaryKind::Final,
    )
    .await
}

// ---- Notes ---------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn get_meeting_notes(app: AppHandle, meeting_id: String) -> Result<MeetingNotes, String> {
    manager(&app)?
        .store()
        .get_notes(&meeting_id)
        .map_err(|e| e.to_string())
}

/// Saves the notepad. Called on a debounce while the user types, so it is
/// deliberately a plain overwrite with no merge and no history.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_notes(app: AppHandle, meeting_id: String, notes: String) -> Result<(), String> {
    manager(&app)?
        .store()
        .set_notes(&meeting_id, &notes)
        .map_err(|e| e.to_string())
}

/// Saves an edited enhancement.
///
/// The enhanced version is a document the user owns once it exists — they will
/// fix the one line the model got wrong — so it is editable and re-runnable
/// rather than a read-only artefact.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_enhanced_notes(
    app: AppHandle,
    meeting_id: String,
    notes: String,
) -> Result<(), String> {
    manager(&app)?
        .store()
        .set_enhanced_notes(&meeting_id, &notes, chrono::Utc::now().timestamp())
        .map_err(|e| e.to_string())
}

/// Completes the user's notes from the transcript, storing both versions.
///
/// Runs on the async runtime and can take a while on a long meeting: the
/// transcript is condensed first when it will not fit in one request.
#[tauri::command]
#[specta::specta]
pub async fn enhance_meeting_notes(app: AppHandle, meeting_id: String) -> Result<String, String> {
    let manager = manager(&app)?;
    let body = crate::meetings::notes::enhance(&app, manager.store(), &meeting_id).await?;
    // The panel and the library are separate windows looking at the same row.
    // Whichever one started this, the other has to hear about it.
    let _ = app.emit(
        "meeting-notes-enhanced",
        crate::meetings::types::MeetingNotesEnhancedEvent {
            meeting_id,
            body: body.clone(),
        },
    );
    Ok(body)
}

// ---- Panel & capture control --------------------------------------------

/// Pauses or resumes capture without ending the meeting.
///
/// Keeps the tap and microphone open so resuming is instant — tearing the tap
/// down and rebuilding it costs seconds on first use.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_paused(app: AppHandle, paused: bool) -> Result<(), String> {
    manager(&app)?.set_paused(paused);
    Ok(())
}

/// Remembers how the panel is split between transcript and notepad.
///
/// Its own command rather than a write through [`update_meeting_settings`]:
/// that one takes the whole settings block, and the panel would have to read
/// it back on every drag just to avoid clobbering a preference changed in the
/// main window meanwhile.
#[tauri::command]
#[specta::specta]
pub fn set_meeting_notes_layout(app: AppHandle, split: f64, collapsed: bool) -> Result<(), String> {
    let mut settings = get_settings(&app);
    // Clamped here as well as in the panel, because settings are also editable
    // by hand and a ratio of 0 would present as a pane that will not open.
    settings.meeting.notes_split = split.clamp(0.2, 0.85);
    settings.meeting.notes_collapsed = collapsed;
    write_settings(&app, settings);
    Ok(())
}

/// Hides the floating panel.
///
/// The panel is an NSPanel, so `getCurrentWindow().hide()` from the webview is
/// not reliable — hiding has to go through the same main-thread path that
/// created it.
#[tauri::command]
#[specta::specta]
pub fn hide_meeting_panel(app: AppHandle) {
    crate::meetings::panel::hide(&app);
}

#[tauri::command]
#[specta::specta]
pub fn show_meeting_panel(app: AppHandle) {
    crate::meetings::panel::show(&app);
}

// ---- Library -------------------------------------------------------------

/// A meeting plus the counts the list view needs, so the UI does not issue a
/// query per row.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummaryRow {
    pub meeting: Meeting,
    pub segment_count: i64,
    /// Most recent summary body, when one exists.
    pub summary: Option<String>,
    pub tags: Vec<String>,
    /// Both versions of the notepad, so a row can show which it has without a
    /// query per row.
    pub notes: MeetingNotes,
}

/// Meetings for the library list, optionally filtered by text and date.
#[tauri::command]
#[specta::specta]
pub fn browse_meetings(
    app: AppHandle,
    query: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<MeetingSummaryRow>, String> {
    let manager = manager(&app)?;
    let store = manager.store();
    let limit = limit.unwrap_or(200);

    let meetings = match (
        query.as_deref().map(str::trim).filter(|q| !q.is_empty()),
        from,
        to,
    ) {
        (Some(q), _, _) => store.search_meetings(q, limit),
        (None, Some(from), Some(to)) => store.meetings_in_range(from, to, limit),
        _ => store.list_meetings(limit),
    }
    .map_err(|e| e.to_string())?;

    // Apply the date filter on top of a text search too, so the two controls
    // compose rather than overriding one another.
    let filtered = meetings.into_iter().filter(|m| {
        from.map_or(true, |f| m.started_at >= f) && to.map_or(true, |t| m.started_at <= t)
    });

    Ok(filtered
        .map(|meeting| {
            let segment_count = store.segment_count(&meeting.id).unwrap_or(0);
            let summary = store
                .list_summaries(&meeting.id)
                .ok()
                .and_then(|list| list.into_iter().next_back().map(|s| s.body));
            let tags = store.tags_for(&meeting.id).unwrap_or_default();
            let notes = store.get_notes(&meeting.id).unwrap_or_default();
            MeetingSummaryRow {
                meeting,
                segment_count,
                summary,
                tags,
                notes,
            }
        })
        .collect())
}

/// Renders one meeting as text for export or copying.
fn render_meeting_document(
    store: &crate::meetings::MeetingStore,
    meeting_id: &str,
    markdown: bool,
) -> Result<String, String> {
    let meeting = store
        .get_meeting(meeting_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That meeting no longer exists.".to_string())?;
    let segments = store.list_segments(meeting_id).map_err(|e| e.to_string())?;
    let summaries = store.list_summaries(meeting_id).unwrap_or_default();
    let notes = store.get_notes(meeting_id).unwrap_or_default();

    let title = meeting
        .title
        .clone()
        .unwrap_or_else(|| "Meeting".to_string());
    let started = chrono::DateTime::from_timestamp(meeting.started_at, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();

    let mut out = String::new();
    if markdown {
        out.push_str(&format!("# {title}\n\n_{started}_\n\n"));
    } else {
        out.push_str(&format!("{title}\n{started}\n\n"));
    }

    if !meeting.captured_system_audio {
        out.push_str(
            "(Your side of the call only — the other participants were not captured.)\n\n",
        );
    }

    // Notes lead the document. Once someone has enhanced their notes, that is
    // the thing they are sending on; the summary and the transcript are the
    // evidence behind it.
    if let Some(enhanced) = notes
        .enhanced
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.push_str(if markdown {
            "## Notes\n\n"
        } else {
            "NOTES\n\n"
        });
        out.push_str(enhanced);
        out.push_str("\n\n");
    }
    if let Some(raw) = notes
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Labelled by whether the enhanced version is above it: on its own it
        // is simply "the notes", and calling it "My notes" there would imply a
        // second set that does not exist.
        let heading = if notes.enhanced.is_some() {
            ("## My notes\n\n", "MY NOTES\n\n")
        } else {
            ("## Notes\n\n", "NOTES\n\n")
        };
        out.push_str(if markdown { heading.0 } else { heading.1 });
        out.push_str(raw);
        out.push_str("\n\n");
    }

    if let Some(latest) = summaries.iter().next_back() {
        out.push_str(if markdown {
            "## Summary\n\n"
        } else {
            "SUMMARY\n\n"
        });
        out.push_str(latest.body.trim());
        out.push_str("\n\n");
    }

    out.push_str(if markdown {
        "## Transcript\n\n"
    } else {
        "TRANSCRIPT\n\n"
    });
    out.push_str(&summarizer::render_transcript_plain(&segments));
    Ok(out)
}

/// Transcript and summary as text, for the clipboard.
#[tauri::command]
#[specta::specta]
pub fn export_meeting_text(
    app: AppHandle,
    meeting_id: String,
    markdown: bool,
) -> Result<String, String> {
    let manager = manager(&app)?;
    render_meeting_document(manager.store(), &meeting_id, markdown)
}

/// Writes one meeting to disk. `format` is `md`, `txt` or `json`.
#[tauri::command]
#[specta::specta]
pub fn export_meeting_to_file(
    app: AppHandle,
    meeting_id: String,
    path: String,
    format: String,
) -> Result<(), String> {
    let manager = manager(&app)?;
    let store = manager.store();

    let contents = match format.as_str() {
        "json" => {
            let meeting = store
                .get_meeting(&meeting_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "That meeting no longer exists.".to_string())?;
            let payload = serde_json::json!({
                "meeting": meeting,
                "notes": store.get_notes(&meeting_id).unwrap_or_default(),
                "speakers": store.list_speakers(&meeting_id).unwrap_or_default(),
                "segments": store.list_segments(&meeting_id).map_err(|e| e.to_string())?,
                "summaries": store.list_summaries(&meeting_id).unwrap_or_default(),
            });
            serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
        }
        "txt" => render_meeting_document(store, &meeting_id, false)?,
        _ => render_meeting_document(store, &meeting_id, true)?,
    };

    std::fs::write(&path, contents).map_err(|e| format!("Could not write the file: {e}"))?;
    Ok(())
}

/// Reveals an exported file in Finder.
#[tauri::command]
#[specta::specta]
pub fn reveal_meeting_export(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(std::path::PathBuf::from(path))
        .map_err(|e| format!("Could not reveal the file: {e}"))
}

// ---- Tags ----------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn add_meeting_tag(
    app: AppHandle,
    meeting_id: String,
    name: String,
) -> Result<Vec<String>, String> {
    let manager = manager(&app)?;
    manager
        .store()
        .add_tag(&meeting_id, &name)
        .map_err(|e| e.to_string())?;
    manager
        .store()
        .tags_for(&meeting_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn remove_meeting_tag(
    app: AppHandle,
    meeting_id: String,
    name: String,
) -> Result<Vec<String>, String> {
    let manager = manager(&app)?;
    manager
        .store()
        .remove_tag(&meeting_id, &name)
        .map_err(|e| e.to_string())?;
    manager
        .store()
        .tags_for(&meeting_id)
        .map_err(|e| e.to_string())
}

/// Every tag in use, most-used first — the suggestion list when tagging.
#[tauri::command]
#[specta::specta]
pub fn list_all_meeting_tags(app: AppHandle) -> Result<Vec<String>, String> {
    manager(&app)?.store().all_tags().map_err(|e| e.to_string())
}

/// Exports every meeting matching the current filters into one file.
///
/// Mirrors Notes' bulk export. `format` is `md` or `json`.
#[tauri::command]
#[specta::specta]
pub fn export_all_meetings(
    app: AppHandle,
    path: String,
    format: String,
    query: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
) -> Result<usize, String> {
    let rows = browse_meetings(app.clone(), query, from, to, Some(5000))?;
    let manager = manager(&app)?;
    let store = manager.store();

    let contents = if format == "json" {
        let payload: Vec<_> = rows
            .iter()
            .map(|row| {
                serde_json::json!({
                    "meeting": row.meeting,
                    "tags": row.tags,
                    "notes": row.notes,
                    "speakers": store.list_speakers(&row.meeting.id).unwrap_or_default(),
                    "segments": store.list_segments(&row.meeting.id).unwrap_or_default(),
                    "summaries": store.list_summaries(&row.meeting.id).unwrap_or_default(),
                })
            })
            .collect();
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
    } else {
        let mut out = String::new();
        for row in &rows {
            out.push_str(&render_meeting_document(store, &row.meeting.id, true)?);
            out.push_str("\n\n---\n\n");
        }
        out
    };

    std::fs::write(&path, contents).map_err(|e| format!("Could not write the file: {e}"))?;
    Ok(rows.len())
}
