//! Hands-free continuous dictation.
//!
//! When armed, taps the raw 16 kHz frame stream from `AudioRecordingManager`,
//! runs an independent Silero VAD, and closes a segment whenever sustained
//! trailing silence is detected. Each segment is pushed through the regular
//! `TranscriptionManager::transcribe` path and pasted into the focused
//! application.
//!
//! Dev-mode gated and opt-in. Deliberately isolated from the shortcut-driven
//! recording lifecycle in `AudioRecordingManager` — arming does NOT disable
//! the regular transcribe shortcut, but the two are not expected to overlap
//! in practice.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use log::{debug, error, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio_toolkit::{constants::WHISPER_SAMPLE_RATE, vad::VoiceActivityDetector, SileroVad};
use crate::clipboard::{paste_with_options, send_submit_key, PasteOptions};
use crate::frontmost::{self, AppContext};
use crate::managers::audio::{AudioRecordingManager, MicrophoneMode};
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::{edit_intent, utils as app_utils};

/// 30 ms at 16 kHz.
const FRAME_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize * 30) / 1000;
/// Consecutive speech frames needed to declare segment onset (~60 ms).
const SPEECH_ONSET_FRAMES: u32 = 2;
/// Pre-roll buffer length so segment capture includes audio just before onset.
const PREROLL_FRAMES: usize = 10; // ~300 ms

struct SegmentState {
    vad: Box<dyn VoiceActivityDetector>,
    in_segment: bool,
    consec_speech: u32,
    consec_silence: u32,
    segment: Vec<f32>,
    prefill: VecDeque<Vec<f32>>,
    /// App that was focused when this segment began. Paste will re-focus this
    /// app before delivering the transcribed text.
    target_app: Option<AppContext>,
}

impl SegmentState {
    fn new(vad: Box<dyn VoiceActivityDetector>) -> Self {
        Self {
            vad,
            in_segment: false,
            consec_speech: 0,
            consec_silence: 0,
            segment: Vec::new(),
            prefill: VecDeque::with_capacity(PREROLL_FRAMES),
            target_app: None,
        }
    }

    fn reset(&mut self) {
        self.in_segment = false;
        self.consec_speech = 0;
        self.consec_silence = 0;
        self.segment.clear();
        self.prefill.clear();
        self.target_app = None;
        self.vad.reset();
    }
}

struct Segment {
    samples: Vec<f32>,
    target_app: Option<AppContext>,
}

enum Job {
    Segment(Segment),
    Shutdown,
}

pub struct ContinuousDictationManager {
    app: AppHandle,
    armed: Arc<AtomicBool>,
    state: Arc<Mutex<SegmentState>>,
    job_tx: Mutex<Option<mpsc::SyncSender<Job>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Mode to restore when disarming. Populated at arm time.
    prev_mode: Mutex<Option<MicrophoneMode>>,
}

impl ContinuousDictationManager {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, anyhow::Error> {
        let vad_path = app
            .path()
            .resolve(
                "resources/models/silero_vad_v4.onnx",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| anyhow::anyhow!("Failed to resolve VAD path: {}", e))?;

        let silero = SileroVad::new(vad_path.to_str().unwrap(), 0.45)
            .map_err(|e| anyhow::anyhow!("Failed to create continuous VAD: {}", e))?;

        Ok(Arc::new(Self {
            app,
            armed: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(SegmentState::new(Box::new(silero)))),
            job_tx: Mutex::new(None),
            worker: Mutex::new(None),
            prev_mode: Mutex::new(None),
        }))
    }

    pub fn is_armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    /// Arm the continuous loop. Idempotent.
    pub fn arm(self: &Arc<Self>) -> Result<(), String> {
        if self.is_armed() {
            return Ok(());
        }

        // Enforce dev-mode gate at the boundary.
        let settings = get_settings(&self.app);
        if !settings.experimental_enabled || !settings.continuous_dictation_enabled {
            return Err("Continuous dictation is not enabled".to_string());
        }

        info!("Arming continuous dictation");

        // Spin up the transcribe worker.
        let (tx, rx) = mpsc::sync_channel::<Job>(2);
        let app = self.app.clone();
        let handle = std::thread::spawn(move || transcribe_worker(app, rx));
        *self.job_tx.lock().unwrap() = Some(tx);
        *self.worker.lock().unwrap() = Some(handle);

        // Snapshot current mode, switch to Continuous (opens the stream).
        let rm = self.app.state::<Arc<AudioRecordingManager>>();
        if let Err(e) = rm.preload_vad() {
            warn!("preload_vad failed (continuous will still try): {}", e);
        }
        let cur_mode = rm.current_mode();
        *self.prev_mode.lock().unwrap() = Some(cur_mode.clone());
        if cur_mode != MicrophoneMode::Continuous {
            if let Err(e) = rm.update_mode(MicrophoneMode::Continuous) {
                // Roll back the worker — nothing else has touched state yet.
                self.teardown_worker();
                return Err(format!("failed to switch to Continuous mode: {e}"));
            }
        }

        // Reset VAD state and install the frame listener.
        self.state.lock().unwrap().reset();

        let armed = Arc::clone(&self.armed);
        let state = Arc::clone(&self.state);
        let job_sender = self.job_tx.lock().unwrap().as_ref().unwrap().clone();
        let app_for_cb = self.app.clone();

        rm.set_raw_frame_listener(Some(Box::new(move |frame: &[f32]| {
            if !armed.load(Ordering::SeqCst) {
                return;
            }
            on_frame(&app_for_cb, &state, &job_sender, frame);
        })));

        self.armed.store(true, Ordering::SeqCst);
        change_tray_icon(&self.app, TrayIconState::Recording);
        let _ = self.app.emit("continuous-dictation-armed", true);

        Ok(())
    }

    /// Disarm and flush any in-flight segment. Idempotent.
    pub fn disarm(self: &Arc<Self>) {
        if !self.is_armed() {
            return;
        }
        info!("Disarming continuous dictation");
        self.armed.store(false, Ordering::SeqCst);

        // Detach the listener first so no more frames are pushed.
        let rm = self.app.state::<Arc<AudioRecordingManager>>();
        rm.set_raw_frame_listener(None);

        // Flush any partial segment synchronously into the queue.
        let leftover = {
            let mut s = self.state.lock().unwrap();
            if s.in_segment && !s.segment.is_empty() {
                let samples = std::mem::take(&mut s.segment);
                let target_app = s.target_app.take();
                s.reset();
                Some(Segment {
                    samples,
                    target_app,
                })
            } else {
                s.reset();
                None
            }
        };
        if let Some(seg) = leftover {
            if let Some(tx) = self.job_tx.lock().unwrap().as_ref() {
                let _ = tx.try_send(Job::Segment(seg));
            }
        }

        self.teardown_worker();

        // Restore prior mode.
        let prev = self.prev_mode.lock().unwrap().take();
        if let Some(m) = prev {
            if let Err(e) = rm.update_mode(m) {
                warn!("Failed to restore microphone mode: {}", e);
            }
        }

        change_tray_icon(&self.app, TrayIconState::Idle);
        let _ = self.app.emit("continuous-dictation-armed", false);
    }

    /// Toggle convenience used by the shortcut binding.
    pub fn toggle(self: &Arc<Self>) {
        if self.is_armed() {
            self.disarm();
        } else if let Err(e) = self.arm() {
            error!("Failed to arm continuous dictation: {}", e);
            let _ = self.app.emit("continuous-dictation-error", e);
        }
    }

    fn teardown_worker(&self) {
        if let Some(tx) = self.job_tx.lock().unwrap().take() {
            let _ = tx.send(Job::Shutdown);
        }
        if let Some(h) = self.worker.lock().unwrap().take() {
            let _ = h.join();
        }
    }
}

fn on_frame(
    app: &AppHandle,
    state: &Arc<Mutex<SegmentState>>,
    tx: &mpsc::SyncSender<Job>,
    frame: &[f32],
) {
    // Expect 30 ms frames; defensively skip any mismatch.
    if frame.len() != FRAME_SAMPLES {
        return;
    }
    let settings = get_settings(app);
    let silence_frames = ((settings.continuous_silence_ms as usize) / 30).max(1) as u32;
    let max_segment_frames = (((settings.continuous_max_segment_ms as usize) / 30).max(1)) as u32;
    let min_segment_frames = ((settings.continuous_min_segment_ms as usize) / 30) as u32;

    let mut s = state.lock().unwrap();

    let is_voice = match s.vad.is_voice(frame) {
        Ok(v) => v,
        Err(e) => {
            debug!("VAD error: {}", e);
            return;
        }
    };

    // Maintain pre-roll buffer while not in a segment.
    if !s.in_segment {
        if s.prefill.len() == PREROLL_FRAMES {
            s.prefill.pop_front();
        }
        s.prefill.push_back(frame.to_vec());
    }

    match (s.in_segment, is_voice) {
        (false, true) => {
            s.consec_speech += 1;
            if s.consec_speech >= SPEECH_ONSET_FRAMES {
                // Promote to speaking — prepend pre-roll for natural edges.
                s.in_segment = true;
                s.consec_speech = 0;
                s.consec_silence = 0;
                s.segment.clear();
                // Move prefill into the segment without aliasing `s` twice.
                let prefill: Vec<Vec<f32>> = s.prefill.drain(..).collect();
                for buf in &prefill {
                    s.segment.extend_from_slice(buf);
                }
                // Snapshot the focused app so the paste lands where speech
                // began, even if focus drifts during transcription.
                s.target_app = frontmost::current().ok().flatten();
            }
        }
        (false, false) => {
            s.consec_speech = 0;
        }
        (true, true) => {
            s.consec_silence = 0;
            s.segment.extend_from_slice(frame);
        }
        (true, false) => {
            s.consec_silence += 1;
            s.segment.extend_from_slice(frame);
            if s.consec_silence >= silence_frames {
                flush_segment(&mut s, tx, min_segment_frames);
            }
        }
    }

    // Force-flush on max segment length regardless of VAD.
    if s.in_segment {
        let frames_captured = (s.segment.len() / FRAME_SAMPLES) as u32;
        if frames_captured >= max_segment_frames {
            debug!("Continuous: force-flushing at max segment length");
            flush_segment(&mut s, tx, min_segment_frames);
        }
    }
}

fn flush_segment(s: &mut SegmentState, tx: &mpsc::SyncSender<Job>, min_segment_frames: u32) {
    let frames_captured = (s.segment.len() / FRAME_SAMPLES) as u32;
    let samples = std::mem::take(&mut s.segment);
    let target_app = s.target_app.take();
    s.reset();

    if frames_captured < min_segment_frames {
        debug!(
            "Continuous: dropping segment ({} frames < min {})",
            frames_captured, min_segment_frames
        );
        return;
    }

    let segment = Segment {
        samples,
        target_app,
    };
    match tx.try_send(Job::Segment(segment)) {
        Ok(()) => {}
        Err(mpsc::TrySendError::Full(_)) => {
            warn!("Continuous: transcribe queue full, dropping segment");
        }
        Err(mpsc::TrySendError::Disconnected(_)) => {
            warn!("Continuous: transcribe worker gone, dropping segment");
        }
    }
}

fn transcribe_worker(app: AppHandle, rx: mpsc::Receiver<Job>) {
    while let Ok(job) = rx.recv() {
        let Segment {
            samples,
            target_app,
        } = match job {
            Job::Segment(s) => s,
            Job::Shutdown => break,
        };

        let tm = match app.try_state::<Arc<TranscriptionManager>>() {
            Some(tm) => tm,
            None => {
                error!("Continuous: TranscriptionManager not available");
                continue;
            }
        };

        let started = Instant::now();
        let text = match tm.transcribe(samples) {
            Ok(t) => t,
            Err(e) => {
                warn!("Continuous transcription failed: {}", e);
                continue;
            }
        };
        debug!(
            "Continuous segment transcribed in {:?}: {:?}",
            started.elapsed(),
            text
        );

        // Apply correction phrases to keep parity with the main flow.
        let settings = get_settings(&app);
        let text = if settings.correction_phrases_enabled {
            edit_intent::apply_correction_phrases(&text, &settings.correction_phrases)
        } else {
            text
        };

        if text.trim().is_empty() {
            continue;
        }

        // Submit-phrase: if the segment ends with the configured phrase, strip
        // it and fire the submit keystroke after pasting. Empty remainder is
        // valid — the user may have said only "send it" to submit a previously-
        // typed message without adding new content.
        let (text, submit_key) = if settings.continuous_submit_phrase_enabled {
            match strip_trailing_submit_phrase(&text, &settings.continuous_submit_phrase) {
                Some(stripped) => {
                    debug!(
                        "Continuous: submit phrase matched, stripped tail. Will fire {:?}",
                        settings.continuous_submit_key
                    );
                    (stripped, Some(settings.continuous_submit_key))
                }
                None => (text, None),
            }
        } else {
            (text, None)
        };

        let has_text_to_paste = !text.trim().is_empty();

        // Persist to history (best-effort). We skip WAV save here — continuous
        // mode would create one file per utterance and flood the recordings dir.
        // Skip the entry entirely when the segment was just a bare submit
        // phrase ("send it") — there's nothing useful to record.
        if has_text_to_paste {
            if let Some(hm) = app.try_state::<Arc<HistoryManager>>() {
                let source_app = target_app.as_ref().and_then(frontmost::display_name);
                if let Err(e) =
                    hm.save_entry(String::new(), text.clone(), false, None, None, source_app)
                {
                    debug!("Continuous: history save failed: {}", e);
                }
            }
        }

        // Output-target lock: if the focused app drifted since segment onset,
        // attempt to re-focus the original target. If re-focus fails, drop the
        // paste instead of dumping transcript into the wrong window.
        if !ensure_target_focused(&app, target_app.as_ref()) {
            warn!(
                "Continuous: dropping segment — target app gone or unfocusable ({:?})",
                target_app
            );
            let _ = app.emit("continuous-dictation-target-lost", &text);
            continue;
        }

        let ah = app.clone();
        let text_for_paste = text.clone();
        let _ = app.run_on_main_thread(move || {
            if has_text_to_paste {
                let opts = PasteOptions {
                    // Suppress trailing space when we're about to fire submit —
                    // an extra space before Enter is at best noise, at worst a
                    // bad command in some shells/editors.
                    append_trailing_space: if submit_key.is_some() {
                        Some(false)
                    } else {
                        None
                    },
                    replace_prior_chars: None,
                    suppress_auto_submit: true,
                };
                if let Err(e) = paste_with_options(text_for_paste, ah.clone(), opts) {
                    warn!("Continuous paste failed: {}", e);
                    let _ = ah.emit("paste-error", ());
                    return;
                }
            }
            if let Some(key) = submit_key {
                // Brief delay so the host app commits the paste before Enter
                // fires — same 50ms used by the regular paste path.
                std::thread::sleep(Duration::from_millis(50));
                if let Err(e) = send_submit_key(&ah, key) {
                    warn!("Continuous submit-phrase keypress failed: {}", e);
                }
            }
        });

        // Briefly touch the overlay/tray so the user sees feedback.
        app_utils::hide_recording_overlay(&app);
    }
    debug!("Continuous transcribe worker exiting");
}

/// Ensure the originally-focused app is frontmost before pasting. Returns
/// `true` if the target is focused (or no target was snapshotted, in which
/// case we fall through to the current frontmost app).
fn ensure_target_focused(_app: &AppHandle, target: Option<&AppContext>) -> bool {
    let Some(target) = target else {
        return true; // no snapshot, paste wherever focus is now
    };

    let current = frontmost::current().ok().flatten();
    if let Some(cur) = &current {
        if same_app(cur, target) {
            return true;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(bundle_id) = &target.bundle_id {
            use std::process::Command;
            let script = format!(
                "tell application id \"{}\" to activate",
                bundle_id.replace('"', "")
            );
            let status = Command::new("osascript").args(["-e", &script]).status();
            if matches!(status, Ok(s) if s.success()) {
                // Give the WM a moment to complete the focus switch. 120ms is
                // enough on current macOS versions without feeling laggy.
                std::thread::sleep(Duration::from_millis(120));
                let verify = frontmost::current().ok().flatten();
                if let Some(cur) = verify {
                    return same_app(&cur, target);
                }
            }
        }
        false
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Non-macOS: no re-focus implementation yet. Be permissive so the
        // feature is usable; v2 can add per-platform reactivation.
        true
    }
}

/// If `text` ends with `phrase` (case-insensitive, word-boundary, ignoring
/// trailing whitespace and sentence punctuation), return the text with the
/// phrase stripped. Otherwise return `None`.
///
/// "send it" matches "...send it", "...send it.", "...Send it!" but not
/// "...resend it" or "...send it back".
fn strip_trailing_submit_phrase(text: &str, phrase: &str) -> Option<String> {
    let phrase = phrase.trim();
    if phrase.is_empty() {
        return None;
    }
    let trim_end = |s: &str| {
        s.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, '.' | ',' | '!' | '?' | ';' | ':')
        })
        .to_string()
    };

    let trimmed = trim_end(text);
    let lower = trimmed.to_lowercase();
    let phrase_lower = phrase.to_lowercase();
    if !lower.ends_with(&phrase_lower) {
        return None;
    }
    let cut = trimmed.len() - phrase_lower.len();
    // Word-boundary: the char before `phrase` must not be alphabetic, else
    // we'd match "resend it" as ending in "send it".
    if cut > 0 {
        if let Some(prev) = trimmed[..cut].chars().next_back() {
            if prev.is_alphabetic() {
                return None;
            }
        }
    }
    Some(trim_end(&trimmed[..cut]))
}

fn same_app(a: &AppContext, b: &AppContext) -> bool {
    match (&a.bundle_id, &b.bundle_id) {
        (Some(x), Some(y)) => x == y,
        _ => a.process_name == b.process_name && a.process_name.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::strip_trailing_submit_phrase;

    #[test]
    fn matches_at_end_only() {
        assert_eq!(
            strip_trailing_submit_phrase("draft the email send it", "send it").as_deref(),
            Some("draft the email")
        );
    }

    #[test]
    fn ignores_trailing_punctuation() {
        assert_eq!(
            strip_trailing_submit_phrase("draft the email Send it.", "send it").as_deref(),
            Some("draft the email")
        );
        assert_eq!(
            strip_trailing_submit_phrase("ok send it!", "send it").as_deref(),
            Some("ok")
        );
    }

    #[test]
    fn returns_empty_when_phrase_is_entire_text() {
        assert_eq!(
            strip_trailing_submit_phrase("Send it.", "send it").as_deref(),
            Some("")
        );
    }

    #[test]
    fn rejects_non_word_boundary() {
        assert!(strip_trailing_submit_phrase("please resend it", "send it").is_none());
    }

    #[test]
    fn rejects_phrase_in_the_middle() {
        assert!(
            strip_trailing_submit_phrase("send it back to me", "send it").is_none(),
            "phrase mid-sentence should not strip"
        );
    }

    #[test]
    fn empty_phrase_never_matches() {
        assert!(strip_trailing_submit_phrase("anything", "  ").is_none());
    }
}
