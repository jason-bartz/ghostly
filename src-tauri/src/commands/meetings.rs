//! Commands backing Meeting Mode.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use crate::meetings::detector::MeetingDetector;
use crate::meetings::summarizer;
use crate::meetings::types::{
    DetectionSource, Meeting, MeetingSegment, MeetingSpeaker, MeetingStatus, MeetingSummary,
    SummaryKind,
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

/// Transcript as speaker-attributed plain text, for copy/export.
#[tauri::command]
#[specta::specta]
pub fn export_meeting_transcript(app: AppHandle, meeting_id: String) -> Result<String, String> {
    let store = manager(&app)?;
    let store = store.store();
    let segments = store
        .list_segments(&meeting_id)
        .map_err(|e| e.to_string())?;
    let speakers = store.list_speakers(&meeting_id).unwrap_or_default();
    Ok(summarizer::render_transcript(&segments, &speakers))
}

// ---- Speakers ------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn rename_meeting_speaker(
    app: AppHandle,
    speaker_id: String,
    display_name: String,
) -> Result<(), String> {
    manager(&app)?
        .store()
        .rename_speaker(&speaker_id, &display_name)
        .map_err(|e| e.to_string())
}

/// Folds one speaker into another, reassigning all their segments.
#[tauri::command]
#[specta::specta]
pub fn merge_meeting_speakers(
    app: AppHandle,
    target_id: String,
    source_id: String,
) -> Result<usize, String> {
    manager(&app)?
        .store()
        .merge_speakers(&target_id, &source_id)
        .map_err(|e| e.to_string())
}

/// Reassigns a single segment to a different speaker.
#[tauri::command]
#[specta::specta]
pub fn assign_meeting_segment_speaker(
    app: AppHandle,
    segment_id: i64,
    speaker_id: String,
) -> Result<(), String> {
    manager(&app)?
        .store()
        .assign_segment_speaker(segment_id, &speaker_id)
        .map_err(|e| e.to_string())
}

/// Moves every segment currently attributed to one speaker onto another — the
/// "and all their other lines" affordance after a correction.
#[tauri::command]
#[specta::specta]
pub fn reassign_meeting_speaker_segments(
    app: AppHandle,
    meeting_id: String,
    from_speaker_id: String,
    to_speaker_id: String,
) -> Result<usize, String> {
    manager(&app)?
        .store()
        .reassign_all_segments(&meeting_id, &from_speaker_id, &to_speaker_id)
        .map_err(|e| e.to_string())
}

/// Adds a speaker the user names by hand, for assigning segments to.
#[tauri::command]
#[specta::specta]
pub fn add_meeting_speaker(
    app: AppHandle,
    meeting_id: String,
    display_name: String,
) -> Result<MeetingSpeaker, String> {
    let manager = manager(&app)?;
    let store = manager.store();
    let existing = store
        .list_speakers(&meeting_id)
        .map_err(|e| e.to_string())?;
    let color_index = existing.iter().map(|s| s.color_index).max().unwrap_or(0) + 1;

    let speaker = MeetingSpeaker {
        id: format!("spk_{meeting_id}_manual{color_index}"),
        meeting_id: meeting_id.clone(),
        display_name: Some(display_name),
        kind: crate::meetings::types::SpeakerKind::Named,
        lane: crate::meetings::types::Lane::System,
        cluster_index: None,
        voiceprint_id: None,
        pinned: true,
        color_index,
    };
    store.upsert_speaker(&speaker).map_err(|e| e.to_string())?;
    Ok(speaker)
}

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
            MeetingSummaryRow {
                meeting,
                segment_count,
                summary,
                tags,
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
    let speakers = store.list_speakers(meeting_id).unwrap_or_default();
    let summaries = store.list_summaries(meeting_id).unwrap_or_default();

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
    out.push_str(&summarizer::render_transcript(&segments, &speakers));
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
