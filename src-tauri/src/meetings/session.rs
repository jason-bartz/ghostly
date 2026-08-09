//! Meeting capture session — the dual-lane engine.
//!
//! # Shape
//!
//! ```text
//!   mic frames  ─┐                         ┌─ segmenter ─┐
//!  (recorder)    ├─ keyed frame listener ──┤             ├─→ job queue ─→ worker
//!  system frames ┘   / system_audio tap    └─ segmenter ─┘                  │
//!                                                                          ▼
//!                                            store + dedup + events ←── transcribe
//! ```
//!
//! Both lanes segment independently but share one transcription worker. That is
//! deliberate: [`TranscriptionManager`] holds a single engine behind a mutex, so
//! two concurrent callers would serialize anyway — doing it explicitly keeps
//! segment ordering deterministic and avoids two threads contending for the
//! model.
//!
//! # Threading
//!
//! * Frame callbacks run on the recorder worker (mic) and our resampler thread
//!   (system). They only push into a bounded queue.
//! * One worker thread owns transcription, deduplication, and persistence.
//! * `start()` runs off the main thread because the first system-audio tap can
//!   take several seconds to build.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_toolkit::vad::{SileroVad, SmoothedVad};
use crate::managers::audio::{AudioRecordingManager, MicrophoneMode, RAW_FRAME_LISTENER_MEETING};
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, MeetingSettings};

use super::dedup::CrossLaneDeduper;
use super::lane::{CapturedSegment, LaneSegmenter, SegmenterConfig};
use super::speakers::SpeakerRegistry;
use super::store::MeetingStore;
use super::types::{
    DetectionSource, LabelSource, Lane, MeetingSegmentEvent, MeetingStatus, MeetingStatusEvent,
    NewSegment,
};

/// Bound on the queue between segmenters and the transcription worker. Each
/// entry is a whole utterance, so this is a lot of slack; if it ever fills, the
/// model is far behind real time and dropping is the only sane response.
const JOB_QUEUE_CAPACITY: usize = 64;

enum Job {
    Segment {
        lane: Lane,
        segment: CapturedSegment,
    },
    Stop,
}

/// Everything about the meeting currently being captured.
struct ActiveSession {
    meeting_id: String,
    title: Option<String>,
    started_at: i64,
    /// How this capture began. Drives whether auto-stop may end it.
    detection_source: DetectionSource,
    app_bundle_id: Option<String>,
    app_display_name: Option<String>,
    system_audio_active: bool,
    system_audio_error: Option<String>,
    job_tx: mpsc::SyncSender<Job>,
    worker: Option<std::thread::JoinHandle<()>>,
    /// Retained so `stop` can flush whatever utterance is still open. Without
    /// this the last thing said in every meeting is silently discarded.
    mic_segmenter: Arc<Mutex<LaneSegmenter>>,
    system_segmenter: Option<Arc<Mutex<LaneSegmenter>>>,
    /// Restored when capture stops.
    previous_mic_mode: Option<MicrophoneMode>,
}

pub struct MeetingManager {
    app: AppHandle,
    store: MeetingStore,
    active: Mutex<Option<ActiveSession>>,
    /// Read from frame callbacks without taking the session lock.
    capturing: Arc<AtomicBool>,
    /// Gates frame intake without tearing the lanes down. Pausing keeps the tap
    /// and microphone open so resuming is instantaneous — rebuilding the tap
    /// costs seconds on first use.
    paused: Arc<AtomicBool>,
    /// Serialises start/stop so two shortcut presses cannot interleave.
    transition: Mutex<()>,
    /// Incremented on every start. Background tasks capture the value current
    /// when they were spawned and exit as soon as it changes, so work belonging
    /// to a finished meeting can never bleed into the next one.
    generation: Arc<std::sync::atomic::AtomicU64>,
}

impl MeetingManager {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, anyhow::Error> {
        let store = MeetingStore::new(&app)?;
        Ok(Arc::new(Self {
            app,
            store,
            active: Mutex::new(None),
            capturing: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            transition: Mutex::new(()),
            generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }))
    }

    pub fn store(&self) -> &MeetingStore {
        &self.store
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> MeetingStatus {
        let guard = self.active.lock().unwrap();
        match guard.as_ref() {
            None => MeetingStatus::default(),
            Some(session) => MeetingStatus {
                active: true,
                meeting_id: Some(session.meeting_id.clone()),
                title: session.title.clone(),
                started_at: Some(session.started_at),
                system_audio_active: session.system_audio_active,
                app_display_name: session.app_display_name.clone(),
                system_audio_error: session.system_audio_error.clone(),
                paused: self.paused.load(Ordering::SeqCst),
            },
        }
    }

    fn emit_status(&self) {
        let status = self.status();
        let _ = self
            .app
            .emit("meeting-status", MeetingStatusEvent { status });

        // Rebuild the tray so its entry reads "Start Meeting" or "End Meeting"
        // to match reality. Menu construction touches AppKit, so it has to run
        // on the main thread — `start`/`stop` are called from workers.
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let state = crate::tray::current_tray_state(&app);
            crate::tray::update_tray_menu(&app, &state, None);
        });
    }

    /// Begins capturing.
    ///
    /// **Blocking** — starting the system-audio tap can stall for seconds on
    /// first use. Call from a worker thread.
    pub fn start(
        self: &Arc<Self>,
        detection_source: DetectionSource,
        app_bundle_id: Option<String>,
        app_display_name: Option<String>,
        title: Option<String>,
    ) -> Result<String, String> {
        let _guard = self.transition.lock().unwrap();

        if self.is_capturing() {
            return Err("A meeting is already being captured.".to_string());
        }

        let settings = get_settings(&self.app);
        if !settings.meeting.enabled {
            return Err("Meeting Mode is turned off.".to_string());
        }

        // Both features snapshot and restore the *global* microphone mode, so
        // running them together makes whichever stops last restore a stale mode
        // — typically leaving the stream forced open forever, or killing the
        // other's capture. They are also redundant: both are hands-free
        // continuous listening. Refuse rather than silently misbehave.
        if let Some(continuous) = self
            .app
            .try_state::<Arc<crate::managers::continuous::ContinuousDictationManager>>()
        {
            if continuous.is_armed() {
                return Err(
                    "Continuous dictation is armed. Turn it off before capturing a meeting."
                        .to_string(),
                );
            }
        }

        // Free-tier cap, checked once at session start rather than per segment.
        // An hour of continuous meeting transcription would otherwise be the
        // largest unmetered path in the product — the shortcut-driven dictation
        // gate in `actions.rs` never sees it.
        if let Some(usage) = self
            .app
            .try_state::<Arc<crate::managers::usage::UsageManager>>()
        {
            match usage.check_limit(settings.effective_is_pro()) {
                crate::managers::usage::LimitCheck::OverLimit => {
                    let _ = self.app.emit("usage-limit-reached", ());
                    return Err("You've reached this week's free transcription limit.".to_string());
                }
                crate::managers::usage::LimitCheck::FirstWarning => {
                    let _ = self.app.emit("usage-warning", ());
                }
                crate::managers::usage::LimitCheck::Allowed => {}
            }
        }

        let meeting_config = settings.meeting.clone();
        let meeting_id = format!("mtg_{}", Utc::now().timestamp_millis());
        let started_at = Utc::now().timestamp();

        self.store
            .create_meeting(
                &meeting_id,
                title.as_deref(),
                started_at,
                app_bundle_id.as_deref(),
                app_display_name.as_deref(),
                detection_source,
                false,
            )
            .map_err(|e| format!("Could not create the meeting record: {e}"))?;

        // Keep the model resident for the duration rather than paying a load on
        // the first utterance.
        if let Some(tm) = self.app.try_state::<Arc<TranscriptionManager>>() {
            tm.initiate_model_load();
        }

        let (job_tx, job_rx) = mpsc::sync_channel::<Job>(JOB_QUEUE_CAPACITY);

        // Build every fallible resource *before* mutating shared audio state.
        // An early return after switching the microphone mode or installing the
        // frame listener would strand both, leaving the stream open and a dead
        // listener attached with no session to remove it.
        let mic_segmenter = match build_segmenter(&self.app, &meeting_config) {
            Ok(segmenter) => Arc::new(Mutex::new(segmenter)),
            Err(e) => {
                let _ = self.store.delete_meeting(&meeting_id);
                return Err(e);
            }
        };
        let system_segmenter = if meeting_config.capture_system_audio {
            match build_segmenter(&self.app, &meeting_config) {
                Ok(segmenter) => Some(Arc::new(Mutex::new(segmenter))),
                Err(e) => {
                    let _ = self.store.delete_meeting(&meeting_id);
                    return Err(e);
                }
            }
        } else {
            None
        };

        // ---- Worker --------------------------------------------------------
        // Spawned before the lanes so a spawn failure cannot strand them.
        let worker = {
            let app = self.app.clone();
            let store = self.store.clone();
            let worker_meeting_id = meeting_id.clone();
            let config = meeting_config.clone();
            match std::thread::Builder::new()
                .name("ghostly-meeting-worker".into())
                .spawn(move || transcribe_worker(app, store, worker_meeting_id, config, job_rx))
            {
                Ok(handle) => handle,
                Err(e) => {
                    let _ = self.store.delete_meeting(&meeting_id);
                    return Err(format!("Could not start the meeting worker: {e}"));
                }
            }
        };

        // ---- Microphone lane ---------------------------------------------
        let recording_manager = self.app.state::<Arc<AudioRecordingManager>>();
        let previous_mic_mode = Some(recording_manager.current_mode());
        if let Err(e) = recording_manager.update_mode(MicrophoneMode::Continuous) {
            // Unwind the worker so its thread does not outlive the failed start.
            let _ = job_tx.send(Job::Stop);
            let _ = worker.join();
            let _ = self.store.delete_meeting(&meeting_id);
            return Err(format!("Could not open the microphone: {e}"));
        }

        let mic_segmenter_for_session = Arc::clone(&mic_segmenter);
        let capturing = Arc::clone(&self.capturing);
        let paused_mic = Arc::clone(&self.paused);
        let mic_tx = job_tx.clone();
        let mic_seg_for_cb = Arc::clone(&mic_segmenter);
        recording_manager.add_raw_frame_listener(
            RAW_FRAME_LISTENER_MEETING,
            Arc::new(move |frame: &[f32]| {
                if !capturing.load(Ordering::SeqCst) || paused_mic.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut segmenter) = mic_seg_for_cb.lock() else {
                    return;
                };
                if let Some(segment) = segmenter.push_frame(frame) {
                    let _ = mic_tx.try_send(Job::Segment {
                        lane: Lane::Mic,
                        segment,
                    });
                }
            }),
        );

        // ---- System lane --------------------------------------------------
        let mut system_audio_active = false;
        let mut system_audio_error = None;

        let system_segmenter_for_session = system_segmenter.as_ref().map(Arc::clone);
        if let Some(system_segmenter) = system_segmenter {
            let capturing = Arc::clone(&self.capturing);
            let paused_system = Arc::clone(&self.paused);
            let system_tx = job_tx.clone();
            let result = crate::system_audio::start(Arc::new(move |frame: &[f32]| {
                if !capturing.load(Ordering::SeqCst) || paused_system.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut segmenter) = system_segmenter.lock() else {
                    return;
                };
                if let Some(segment) = segmenter.push_frame(frame) {
                    let _ = system_tx.try_send(Job::Segment {
                        lane: Lane::System,
                        segment,
                    });
                }
            }));

            match result {
                Ok(()) => system_audio_active = true,
                Err(e) => {
                    // A one-sided transcript is still useful, so this is not
                    // fatal — but the UI must say so rather than pretending.
                    warn!("Meeting: system audio unavailable, continuing mic-only: {e}");
                    system_audio_error = Some(e);
                }
            }
        }

        let _ = self
            .store
            .set_captured_system_audio(&meeting_id, system_audio_active);

        self.generation.fetch_add(1, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.capturing.store(true, Ordering::SeqCst);
        *self.active.lock().unwrap() = Some(ActiveSession {
            meeting_id: meeting_id.clone(),
            title,
            started_at,
            detection_source,
            app_bundle_id,
            app_display_name,
            system_audio_active,
            system_audio_error,
            job_tx,
            worker: Some(worker),
            mic_segmenter: mic_segmenter_for_session,
            system_segmenter: system_segmenter_for_session,
            previous_mic_mode,
        });

        info!(
            "Meeting capture started ({meeting_id}), system audio: {}",
            system_audio_active
        );

        // Rolling summaries. Without these, "catch me up" on a long call would
        // have to fold the entire raw transcript on the spot; with them it
        // folds a handful of short paragraphs and feels instant.
        if meeting_config.rolling_summary_minutes > 0 {
            let app = self.app.clone();
            let capturing = Arc::clone(&self.capturing);
            let store = self.store.clone();
            let generation = Arc::clone(&self.generation);
            let my_generation = self.generation.load(Ordering::SeqCst);
            let meeting_id_for_summary = meeting_id.clone();
            let interval = Duration::from_secs(meeting_config.rolling_summary_minutes as u64 * 60);
            let started = started_at;

            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    // Guard on this task's own generation, not just the global
                    // capturing flag: a task from a finished meeting would
                    // otherwise wake during the *next* meeting and write
                    // summaries into the previous meeting's row.
                    if !capturing.load(Ordering::SeqCst)
                        || generation.load(Ordering::SeqCst) != my_generation
                    {
                        break;
                    }
                    let from_ms = store
                        .last_summarised_ms(&meeting_id_for_summary)
                        .unwrap_or(0);
                    let to_ms = (Utc::now().timestamp() - started) * 1000;
                    if to_ms <= from_ms {
                        continue;
                    }
                    // Best-effort: a failed rolling summary must never disturb
                    // capture, and the next tick will retry the same window.
                    if let Err(e) = super::summarizer::summarize_window(
                        &app,
                        &store,
                        &meeting_id_for_summary,
                        from_ms,
                        to_ms,
                        super::types::SummaryKind::Rolling,
                    )
                    .await
                    {
                        debug!("Meeting: rolling summary skipped: {e}");
                    }
                }
            });
        }

        if meeting_config.show_live_panel {
            // NSPanel work is main-thread-only, and `start` runs on a worker.
            let app = self.app.clone();
            let _ = self.app.run_on_main_thread(move || {
                super::panel::show(&app);
            });
        }

        self.emit_status();
        Ok(meeting_id)
    }

    /// Stops capture and finalises the meeting. Idempotent.
    pub fn stop(self: &Arc<Self>) -> Option<String> {
        let _guard = self.transition.lock().unwrap();

        if !self.capturing.swap(false, Ordering::SeqCst) {
            return None;
        }
        self.paused.store(false, Ordering::SeqCst);

        // Detach listeners before anything else so no further frames arrive.
        if let Some(rm) = self.app.try_state::<Arc<AudioRecordingManager>>() {
            rm.remove_raw_frame_listener(RAW_FRAME_LISTENER_MEETING);
        }
        crate::system_audio::stop();

        let session = self.active.lock().unwrap().take();
        let Some(mut session) = session else {
            return None;
        };

        // Flush whatever utterance was still open in each lane. The listeners
        // are already detached, so this is the only chance to keep the last
        // thing said in the meeting — without it every transcript loses its
        // final sentence.
        for (lane, segmenter) in [
            (Lane::Mic, Some(&session.mic_segmenter)),
            (Lane::System, session.system_segmenter.as_ref()),
        ] {
            let Some(segmenter) = segmenter else { continue };
            let flushed = segmenter.lock().ok().and_then(|mut s| s.finish());
            if let Some(segment) = flushed {
                // Blocking `send`: this must not be dropped by a full queue.
                let _ = session.job_tx.send(Job::Segment { lane, segment });
            }
        }

        // Drain the queue, then join. `send` rather than `try_send` so the stop
        // marker is never dropped by a momentarily full queue.
        let _ = session.job_tx.send(Job::Stop);
        if let Some(handle) = session.worker.take() {
            let _ = handle.join();
        }

        let ended_at = Utc::now().timestamp();
        if let Err(e) = self.store.finish_meeting(&session.meeting_id, ended_at) {
            error!("Meeting: failed to finalise record: {e}");
        }

        if let Some(rm) = self.app.try_state::<Arc<AudioRecordingManager>>() {
            if let Some(mode) = session.previous_mic_mode {
                if let Err(e) = rm.update_mode(mode) {
                    warn!("Meeting: could not restore microphone mode: {e}");
                }
            }
        }

        // The panel stays open after capture ends so the user can read the
        // transcript, name speakers, and run a wrap-up summary. Only hide it if
        // it was never wanted.
        if !get_settings(&self.app).meeting.show_live_panel {
            let app = self.app.clone();
            let _ = self.app.run_on_main_thread(move || {
                super::panel::hide(&app);
            });
        }

        info!("Meeting capture stopped ({})", session.meeting_id);
        self.emit_status();

        // Wrap-up summary, produced automatically so the panel has something to
        // show the moment the meeting ends rather than requiring another click.
        // Spawned because summarisation is async and may hit the network.
        let app = self.app.clone();
        let store = self.store.clone();
        let summary_id = session.meeting_id.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app.emit("meeting-summarizing", &summary_id);
            match super::summarizer::summarize_window(
                &app,
                &store,
                &summary_id,
                0,
                i64::MAX,
                super::types::SummaryKind::Final,
            )
            .await
            {
                Ok(body) => {
                    let _ = app.emit("meeting-final-summary", body);
                }
                Err(e) => {
                    debug!("Meeting: final summary skipped: {e}");
                    let _ = app.emit("meeting-final-summary-failed", e);
                }
            }
        });

        Some(session.meeting_id)
    }

    /// Milliseconds elapsed since capture began, for time-windowed queries.
    pub fn elapsed_ms(&self) -> i64 {
        let guard = self.active.lock().unwrap();
        guard
            .as_ref()
            .map(|s| (Utc::now().timestamp() - s.started_at) * 1000)
            .unwrap_or(0)
    }

    /// Stops taking audio without ending the meeting.
    pub fn set_paused(&self, paused: bool) {
        if !self.is_capturing() {
            return;
        }
        self.paused.store(paused, Ordering::SeqCst);
        info!(
            "Meeting capture {}",
            if paused { "paused" } else { "resumed" }
        );
        self.emit_status();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn active_meeting_id(&self) -> Option<String> {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.meeting_id.clone())
    }

    /// True when the active capture was started by detection rather than by the
    /// user. Auto-stop only applies to these: a manually started capture must
    /// not be ended just because no recognised conferencing app is running.
    pub fn was_auto_started(&self) -> bool {
        self.active
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| {
                matches!(
                    s.detection_source,
                    DetectionSource::AutoConnect | DetectionSource::Prompted
                )
            })
            .unwrap_or(false)
    }
}

/// Builds a VAD-backed segmenter. Each lane gets its own Silero instance
/// because the model carries streaming state that cannot be shared.
fn build_segmenter(app: &AppHandle, config: &MeetingSettings) -> Result<LaneSegmenter, String> {
    let _ = config;
    let vad_path = app
        .path()
        .resolve(
            "resources/models/silero_vad_v4.onnx",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Could not locate the voice-activity model: {e}"))?;

    let silero = SileroVad::new(
        vad_path
            .to_str()
            .ok_or_else(|| "Voice-activity model path is not valid UTF-8".to_string())?,
        0.4,
    )
    .map_err(|e| format!("Could not load the voice-activity model: {e}"))?;

    // Smoothing matters more here than in push-to-talk dictation: meeting audio
    // is continuous, and an unsmoothed VAD chops conversational speech into
    // fragments at every micro-pause.
    let smoothed = SmoothedVad::new(Box::new(silero), 12, 12, 2);

    Ok(LaneSegmenter::new(
        Box::new(smoothed),
        SegmenterConfig::default(),
    ))
}

/// Transcribes segments in arrival order and commits them.
fn transcribe_worker(
    app: AppHandle,
    store: MeetingStore,
    meeting_id: String,
    config: MeetingSettings,
    rx: mpsc::Receiver<Job>,
) {
    let mut deduper = CrossLaneDeduper::new();
    let mut speakers = SpeakerRegistry::new(&store, &meeting_id);

    while let Ok(job) = rx.recv() {
        let (lane, segment) = match job {
            Job::Segment { lane, segment } => (lane, segment),
            Job::Stop => break,
        };

        let Some(tm) = app.try_state::<Arc<TranscriptionManager>>() else {
            error!("Meeting: transcription manager unavailable");
            continue;
        };

        // `transcribe_private`: meeting audio is other people's speech and
        // must never reach the log file or the diagnostics bundle.
        let text = match tm.transcribe_private(segment.samples) {
            Ok(text) => text,
            Err(e) => {
                warn!("Meeting: transcription failed: {e}");
                continue;
            }
        };
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }

        // Echo suppression. The system lane is the source of truth; a matching
        // microphone segment within the window is the user's speakers bleeding
        // back in, not the user talking.
        match lane {
            Lane::System => deduper.record_system(&text, segment.start_ms, segment.end_ms),
            Lane::Mic => {
                if deduper.is_echo(&text, segment.start_ms, segment.end_ms) {
                    debug!("Meeting: dropped an echoed microphone segment");
                    continue;
                }
            }
        }

        let speaker = match speakers.speaker_for(lane) {
            Ok(speaker) => speaker,
            Err(e) => {
                error!("Meeting: could not resolve speaker: {e}");
                continue;
            }
        };

        let new_segment = NewSegment {
            speaker_id: Some(speaker.id.clone()),
            lane,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: text.clone(),
            label_source: LabelSource::LaneDefault,
            is_crosstalk: false,
            embedding: None,
        };

        let segment_id = match store.insert_segment(&meeting_id, &new_segment) {
            Ok(id) => id,
            Err(e) => {
                error!("Meeting: could not save segment: {e}");
                continue;
            }
        };

        let stored = super::types::MeetingSegment {
            id: segment_id,
            meeting_id: meeting_id.clone(),
            speaker_id: new_segment.speaker_id.clone(),
            lane,
            start_ms: new_segment.start_ms,
            end_ms: new_segment.end_ms,
            text: text.clone(),
            label_source: LabelSource::LaneDefault,
            is_crosstalk: false,
        };

        let _ = app.emit(
            "meeting-segment",
            MeetingSegmentEvent {
                segment: stored,
                speaker: Some(speaker.clone()),
            },
        );

        // Direct-address detection. Far side only — the user saying their own
        // name is not someone calling on them.
        if lane == Lane::System && config.mention_alerts {
            if let Some(mention) = super::mentions::detect(&text, &config.user_display_name) {
                let _ = app.emit(
                    "meeting-mention",
                    super::types::MeetingMentionEvent {
                        meeting_id: meeting_id.clone(),
                        text: mention,
                        speaker_name: speaker.display_name.clone(),
                    },
                );
            }
        }
    }

    // Drain anything still queued so the tail of the meeting is not lost.
    while let Ok(Job::Segment { .. }) = rx.try_recv() {
        // Segments arriving after Stop are discarded deliberately: the lanes
        // are already detached, so these are partial flushes with no listener
        // left to display them.
    }

    debug!("Meeting transcribe worker exiting");
    let _ = Duration::from_millis(0);
}
