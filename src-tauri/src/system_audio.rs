//! System-audio capture lane (the "Others" side of a meeting).
//!
//! Wraps the Swift CoreAudio process-tap bridge in `swift/system_audio.swift`
//! and adapts its native-rate mono float stream to the same 16 kHz / 480-sample
//! (30 ms) frames the microphone lane produces, so both lanes can share VAD and
//! segmentation code.
//!
//! Threading model, and why it is shaped this way:
//!
//! * The Swift callback fires on a CoreAudio render thread. It must not block,
//!   so the trampoline does nothing but copy the samples and push them into a
//!   bounded channel — the same discipline the cpal input callback follows.
//! * The channel sender is allocated once and **deliberately leaked**, matching
//!   `helpers::audio_device_watcher`. A capture that is stopped while a frame is
//!   in flight would otherwise risk a use-after-free across the FFI boundary;
//!   leaking one small allocation for the process lifetime removes that class of
//!   bug entirely.
//! * Resampling happens on our own worker thread, never on the audio thread.
//!
//! `start()` can block for **several seconds** on the first call of a process
//! while coreaudiod builds the tap and aggregate device. Never call it from the
//! main thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use log::{debug, info, warn};

use crate::audio_toolkit::audio::FrameResampler;
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// 30 ms frames, matching `managers::continuous::FRAME_SAMPLES` and the frame
/// size the microphone lane's resampler emits.
const FRAME_DURATION: Duration = Duration::from_millis(30);

/// Bound on the queue between the audio thread and our worker. At 48 kHz a
/// CoreAudio buffer is typically 512 frames (~10 ms), so this is roughly two
/// seconds of slack — enough to ride out a scheduling hiccup, small enough that
/// a wedged worker drops audio instead of growing without bound.
const QUEUE_CAPACITY: usize = 192;

/// Listener invoked with each 16 kHz mono 480-sample frame.
pub type SystemFrameCallback = Arc<dyn Fn(&[f32]) + Send + Sync + 'static>;

struct Chunk {
    samples: Vec<f32>,
    sample_rate: f64,
}

/// Process-global plumbing, created on first use.
struct Plumbing {
    sender: mpsc::SyncSender<Chunk>,
    listener: Arc<Mutex<Option<SystemFrameCallback>>>,
}

static PLUMBING: OnceLock<Plumbing> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

/// Native tap rate, cached on the Rust side.
///
/// The Swift `sampleRate()` accessor takes the same lock `start()` holds for
/// its entire body — and `start()` can block for ten seconds building the tap.
/// Reading the rate from a settings pane or a status command would therefore
/// stall the caller, including the main thread. Cache it here instead.
static NATIVE_RATE_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_char, c_void};

    pub type GhostlySystemAudioCallback = extern "C" fn(
        samples: *const f32,
        frame_count: i32,
        sample_rate: f64,
        userdata: *mut c_void,
    );

    extern "C" {
        pub fn ghostly_system_audio_supported() -> i32;
        pub fn ghostly_system_audio_start(
            callback: GhostlySystemAudioCallback,
            userdata: *mut c_void,
        ) -> i32;
        pub fn ghostly_system_audio_stop();
        pub fn ghostly_system_audio_is_running() -> i32;
        pub fn ghostly_system_audio_sample_rate() -> f64;
        pub fn ghostly_system_audio_last_error() -> *mut c_char;
        pub fn ghostly_processes_using_microphone() -> *mut c_char;
        pub fn ghostly_system_audio_free_string(value: *mut c_char);
    }
}

/// Bundle identifiers of every process currently capturing microphone input,
/// excluding Ghostly itself.
///
/// The meeting-detection signal. Distinguishes "Slack is running" — true all
/// day — from "Slack is in a huddle", which an application allowlist cannot do.
///
/// Note that Electron and Chromium apps open audio from a **helper** process,
/// so entries look like `com.tinyspeck.slackmacgap.helper`. Callers must match
/// by prefix rather than equality; [`is_bundle_capturing`] does this.
pub fn processes_using_microphone() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let raw = ffi::ghostly_processes_using_microphone();
            if raw.is_null() {
                return Vec::new();
            }
            let blob = std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned();
            ffi::ghostly_system_audio_free_string(raw);
            blob.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Whether `bundle_id` — or one of its helper processes — is capturing audio
/// input right now.
pub fn is_bundle_capturing(bundle_id: &str, active: &[String]) -> bool {
    let target = bundle_id.to_ascii_lowercase();
    if target.is_empty() {
        return false;
    }
    active.iter().any(|candidate| {
        let candidate = candidate.to_ascii_lowercase();
        // Exact, or a helper process beneath it. The trailing-dot check stops
        // `com.foo.bar` from matching an unrelated `com.foo.barbaz`.
        candidate == target || candidate.starts_with(&format!("{target}."))
    })
}

/// Pulls the last error out of the Swift side and frees it.
#[cfg(target_os = "macos")]
fn take_last_error() -> Option<String> {
    unsafe {
        let raw = ffi::ghostly_system_audio_last_error();
        if raw.is_null() {
            return None;
        }
        let message = std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned();
        ffi::ghostly_system_audio_free_string(raw);
        Some(message)
    }
}

/// Real-time context: copy and hand off, nothing else.
#[cfg(target_os = "macos")]
extern "C" fn frame_trampoline(
    samples: *const f32,
    frame_count: i32,
    sample_rate: f64,
    _userdata: *mut std::os::raw::c_void,
) {
    if samples.is_null() || frame_count <= 0 {
        return;
    }
    let Some(plumbing) = PLUMBING.get() else {
        return;
    };
    let slice = unsafe { std::slice::from_raw_parts(samples, frame_count as usize) };
    // `try_send` never blocks the audio thread. A full queue means the worker
    // has stalled; dropping is the correct response.
    if plumbing
        .sender
        .try_send(Chunk {
            samples: slice.to_vec(),
            sample_rate,
        })
        .is_err()
    {
        // Deliberately not logged — this runs on the audio thread.
    }
}

fn plumbing() -> &'static Plumbing {
    PLUMBING.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<Chunk>(QUEUE_CAPACITY);
        let listener: Arc<Mutex<Option<SystemFrameCallback>>> = Arc::new(Mutex::new(None));
        let worker_listener = Arc::clone(&listener);

        std::thread::Builder::new()
            .name("ghostly-system-audio".into())
            .spawn(move || resample_worker(rx, worker_listener))
            .expect("failed to spawn system-audio worker");

        Plumbing {
            sender: tx,
            listener,
        }
    })
}

/// Converts native-rate chunks into 16 kHz 480-sample frames and fans them out.
///
/// The resampler is rebuilt whenever the tap's native rate changes, which
/// happens when the user switches output device mid-meeting.
fn resample_worker(rx: mpsc::Receiver<Chunk>, listener: Arc<Mutex<Option<SystemFrameCallback>>>) {
    let mut resampler: Option<FrameResampler> = None;
    let mut current_rate: f64 = 0.0;

    while let Ok(chunk) = rx.recv() {
        if chunk.sample_rate <= 0.0 {
            continue;
        }

        if resampler.is_none() || (chunk.sample_rate - current_rate).abs() > f64::EPSILON {
            info!(
                "System audio lane: building resampler {} Hz -> {} Hz",
                chunk.sample_rate as u32, WHISPER_SAMPLE_RATE
            );
            resampler = Some(FrameResampler::new(
                chunk.sample_rate as usize,
                WHISPER_SAMPLE_RATE as usize,
                FRAME_DURATION,
            ));
            current_rate = chunk.sample_rate;
        }

        // Snapshot the listener so the callback is not invoked while the mutex
        // is held — a listener that re-enters this module would otherwise
        // deadlock.
        let callback = listener.lock().unwrap().clone();
        let Some(callback) = callback else {
            continue;
        };

        if let Some(resampler) = resampler.as_mut() {
            resampler.push(&chunk.samples, |frame| callback(frame));
        }
    }
    debug!("System audio resample worker exiting");
}

/// True when the running OS supports CoreAudio process taps (macOS 14.2+).
pub fn is_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { ffi::ghostly_system_audio_supported() == 1 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Native sample rate of the active tap, or `None` when not capturing.
pub fn native_sample_rate() -> Option<f64> {
    let rate = f64::from_bits(NATIVE_RATE_BITS.load(Ordering::SeqCst));
    (rate > 0.0).then_some(rate)
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Starts capturing system audio, delivering 16 kHz mono 480-sample frames.
///
/// Blocking: the first call in a process can take several seconds. Callers must
/// be on a worker thread.
pub fn start(callback: SystemFrameCallback) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = callback;
        Err("System audio capture is only available on macOS.".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        if !is_supported() {
            return Err(
                "Capturing meeting audio needs macOS 14.2 or later. Ghostly can still transcribe \
                 your own microphone."
                    .to_string(),
            );
        }
        if RUNNING.swap(true, Ordering::SeqCst) {
            return Err("System audio capture is already running.".to_string());
        }

        let plumbing = plumbing();
        *plumbing.listener.lock().unwrap() = Some(callback);

        let status =
            unsafe { ffi::ghostly_system_audio_start(frame_trampoline, std::ptr::null_mut()) };

        if status != 0 {
            *plumbing.listener.lock().unwrap() = None;
            RUNNING.store(false, Ordering::SeqCst);
            let detail = take_last_error()
                .unwrap_or_else(|| format!("System audio capture failed (code {status})."));
            warn!("System audio start failed: {detail}");
            return Err(detail);
        }

        // Safe to call now: `start` has returned, so the Swift lock is free.
        let rate = unsafe { ffi::ghostly_system_audio_sample_rate() };
        NATIVE_RATE_BITS.store(rate.to_bits(), Ordering::SeqCst);

        info!("System audio lane started at {} Hz", rate as u32);
        Ok(())
    }
}

/// Stops capturing. Idempotent.
pub fn stop() {
    if !RUNNING.swap(false, Ordering::SeqCst) {
        return;
    }
    NATIVE_RATE_BITS.store(0, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    unsafe {
        ffi::ghostly_system_audio_stop();
    }
    // Drop the listener only after the Swift side has torn the IOProc down, so
    // no frame can arrive for a listener we have already released.
    if let Some(plumbing) = PLUMBING.get() {
        *plumbing.listener.lock().unwrap() = None;
    }
    info!("System audio lane stopped");
}
