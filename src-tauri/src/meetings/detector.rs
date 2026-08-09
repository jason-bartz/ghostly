//! Meeting auto-detection.
//!
//! # The signal
//!
//! A conferencing app being *installed and running* is nearly useless — Slack,
//! Teams and Discord run all day. The signal that actually separates "Slack is
//! open" from "Slack is in a huddle" is whether that specific process is
//! capturing microphone input, read from CoreAudio's per-process audio objects.
//!
//! This is not the same as `kAudioDevicePropertyDeviceIsRunningSomewhere`,
//! which reports only that *some* process holds the device — a property
//! Ghostly's own always-on microphone trips, making it useless here.
//!
//! # Behaviour
//!
//! Detection never starts capture silently. Under
//! [`MeetingAutoConnect::Auto`] a countdown runs and the user can cancel;
//! under `Ask` the prompt waits for an explicit choice. That countdown is the
//! per-meeting affirmative moment the consent model rests on, so there is
//! deliberately no setting to skip it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::{debug, info};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{get_settings, MeetingAutoConnect, MeetingSettings, MEETING_APP_BUNDLE_IDS};

use super::session::MeetingManager;
use super::types::{DetectionSource, MeetingDetectedEvent};

/// How often to sample. Cheap — one CoreAudio property read plus an NSWorkspace
/// scan — and a couple of seconds of latency at the start of a call is
/// imperceptible.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// A conferencing app currently in a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedMeeting {
    pub bundle_id: String,
    pub display_name: String,
}

/// Applications Ghostly recognises, including any the user added.
fn known_apps(settings: &MeetingSettings) -> Vec<(String, String)> {
    let mut apps: Vec<(String, String)> = MEETING_APP_BUNDLE_IDS
        .iter()
        .map(|(id, name)| (id.to_string(), name.to_string()))
        .collect();
    // A per-app policy implies the user considers it a conferencing app, even
    // if it is not in the built-in list.
    for policy in &settings.app_policies {
        if !apps
            .iter()
            .any(|(id, _)| id.eq_ignore_ascii_case(&policy.bundle_id))
        {
            apps.push((policy.bundle_id.clone(), policy.display_name.clone()));
        }
    }
    apps
}

/// Identifies a call in progress, or `None`.
pub fn detect(settings: &MeetingSettings) -> Option<DetectedMeeting> {
    let capturing = crate::system_audio::processes_using_microphone();
    if capturing.is_empty() {
        return None;
    }

    for (bundle_id, display_name) in known_apps(settings) {
        if crate::system_audio::is_bundle_capturing(&bundle_id, &capturing) {
            return Some(DetectedMeeting {
                bundle_id,
                display_name,
            });
        }
    }
    None
}

/// Effective policy for an app: a per-app override, else the global default.
pub fn policy_for(settings: &MeetingSettings, bundle_id: &str) -> MeetingAutoConnect {
    settings
        .app_policies
        .iter()
        .find(|p| p.bundle_id.eq_ignore_ascii_case(bundle_id))
        .map(|p| p.policy)
        .unwrap_or(settings.auto_connect)
}

/// Whether a title matches a user exclusion (`1:1`, `therapy`, …).
///
/// Small feature, disproportionate trust payoff: it lets someone use
/// auto-connect at all while guaranteeing certain conversations are never
/// captured.
pub fn is_excluded(settings: &MeetingSettings, title: Option<&str>) -> bool {
    let Some(title) = title else { return false };
    let title = title.to_lowercase();
    settings
        .excluded_title_patterns
        .iter()
        .filter(|pattern| !pattern.trim().is_empty())
        .any(|pattern| title.contains(&pattern.trim().to_lowercase()))
}

/// Background service that watches for calls and drives auto-connect.
/// How long a decline suppresses re-prompting for the same app.
///
/// Without this, saying no simply clears `pending`, the next poll three seconds
/// later re-detects the same still-running call, and the prompt (or worse, the
/// countdown) returns immediately — forever. A decline has to mean "not this
/// call", and since a call has no identity beyond the app, time is the proxy.
const DECLINE_COOLDOWN: Duration = Duration::from_secs(30 * 60);

pub struct MeetingDetector {
    app: AppHandle,
    running: Arc<AtomicBool>,
    /// Set while a countdown is pending, so cancelling is possible.
    pending: Arc<Mutex<Option<DetectedMeeting>>>,
    cancelled: Arc<AtomicBool>,
    /// Bundle ids the user declined, with the moment they did so.
    declined: Arc<Mutex<Vec<(String, Instant)>>>,
}

impl MeetingDetector {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            running: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
            declined: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// Cancels a running countdown, or declines a pending prompt.
    ///
    /// Records the decline so the same call is not offered again moments later.
    pub fn cancel_pending(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let declined = self.pending.lock().unwrap().take();
        if let Some(meeting) = declined {
            let mut list = self.declined.lock().unwrap();
            list.retain(|(bundle_id, _)| bundle_id != &meeting.bundle_id);
            list.push((meeting.bundle_id, Instant::now()));
        }
    }

    /// Whether this app was recently declined.
    fn recently_declined(&self, bundle_id: &str) -> bool {
        let mut list = self.declined.lock().unwrap();
        list.retain(|(_, at)| at.elapsed() < DECLINE_COOLDOWN);
        list.iter().any(|(id, _)| id == bundle_id)
    }

    pub fn pending(&self) -> Option<DetectedMeeting> {
        self.pending.lock().unwrap().clone()
    }

    /// Starts the watch loop. Idempotent.
    pub fn spawn(self: &Arc<Self>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("ghostly-meeting-detector".into())
            .spawn(move || this.run())
            .expect("failed to spawn meeting detector");
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    fn run(self: Arc<Self>) {
        info!("Meeting detector started");
        // Tracks how long no call has been seen, for auto-stop.
        let mut absent_since: Option<Instant> = None;

        while self.running.load(Ordering::SeqCst) {
            std::thread::sleep(POLL_INTERVAL);

            let settings = get_settings(&self.app).meeting;
            if !settings.enabled {
                continue;
            }

            let Some(manager) = self.app.try_state::<Arc<MeetingManager>>() else {
                continue;
            };
            let detected = detect(&settings);

            if manager.is_capturing() {
                // ---- auto-stop -------------------------------------------
                // Only ever ends a capture the detector itself started. A
                // manually started meeting must not be stopped because no
                // recognised conferencing app happens to hold the microphone —
                // "record this room" is a legitimate use, and silently ending
                // it after the grace period would look like a crash.
                if !manager.was_auto_started() {
                    absent_since = None;
                    continue;
                }
                match &detected {
                    Some(_) => absent_since = None,
                    None => {
                        let since = *absent_since.get_or_insert_with(Instant::now);
                        let grace = Duration::from_secs(settings.auto_stop_grace_secs as u64);
                        // Generous grace: apps briefly release audio on
                        // mute/unmute and on output-device changes, and
                        // stopping mid-meeting is far worse than stopping late.
                        if since.elapsed() >= grace {
                            info!("Meeting detector: call ended, stopping capture");
                            let manager = Arc::clone(&manager);
                            std::thread::spawn(move || {
                                manager.stop();
                            });
                            absent_since = None;
                        }
                    }
                }
                continue;
            }

            absent_since = None;
            let Some(detected) = detected else {
                // The call ended before the user answered. Clear the prompt and
                // tell the UI, otherwise it lingers with a Start button that
                // would fail because `pending` is already gone.
                let had_pending = self.pending.lock().unwrap().take().is_some();
                if had_pending {
                    self.cancelled.store(true, Ordering::SeqCst);
                    let _ = self.app.emit("meeting-detection-cleared", ());
                    super::panel::hide(&self.app);
                }
                continue;
            };

            // Already prompted for this app and the user has not answered.
            if self.pending.lock().unwrap().as_ref() == Some(&detected) {
                continue;
            }

            let policy = policy_for(&settings, &detected.bundle_id);
            if policy == MeetingAutoConnect::Off {
                continue;
            }
            if is_excluded(&settings, Some(&detected.display_name)) {
                debug!("Meeting detector: {} is excluded", detected.display_name);
                continue;
            }
            if self.recently_declined(&detected.bundle_id) {
                continue;
            }

            *self.pending.lock().unwrap() = Some(detected.clone());
            self.cancelled.store(false, Ordering::SeqCst);

            // The prompt lives in the floating panel, not the settings window.
            // Ghostly normally runs with its main window hidden behind the tray
            // icon, so a prompt rendered only there would mean capture starting
            // with no visible countdown and nothing to cancel — exactly the
            // silent recording the consent model forbids.
            super::panel::show(&self.app);

            match policy {
                MeetingAutoConnect::Ask => {
                    let _ = self.app.emit(
                        "meeting-detected",
                        MeetingDetectedEvent {
                            bundle_id: detected.bundle_id.clone(),
                            display_name: detected.display_name.clone(),
                            countdown_secs: None,
                        },
                    );
                }
                MeetingAutoConnect::Auto => {
                    self.run_countdown(&detected, settings.auto_connect_countdown_secs);
                }
                MeetingAutoConnect::Off => unreachable!("filtered above"),
            }
        }
        info!("Meeting detector stopped");
    }

    /// Emits a per-second countdown, then starts capture unless cancelled.
    fn run_countdown(&self, detected: &DetectedMeeting, seconds: u32) {
        let seconds = seconds.max(1);
        for remaining in (1..=seconds).rev() {
            if self.cancelled.load(Ordering::SeqCst) || !self.running.load(Ordering::SeqCst) {
                return;
            }
            let _ = self.app.emit(
                "meeting-detected",
                MeetingDetectedEvent {
                    bundle_id: detected.bundle_id.clone(),
                    display_name: detected.display_name.clone(),
                    countdown_secs: Some(remaining),
                },
            );
            std::thread::sleep(Duration::from_secs(1));
        }
        if self.cancelled.load(Ordering::SeqCst) {
            return;
        }

        let Some(manager) = self.app.try_state::<Arc<MeetingManager>>() else {
            return;
        };
        let manager = Arc::clone(&manager);
        let detected = detected.clone();
        // Off-thread: starting the system-audio tap can block for seconds.
        std::thread::spawn(move || {
            if let Err(e) = manager.start(
                DetectionSource::AutoConnect,
                Some(detected.bundle_id.clone()),
                Some(detected.display_name.clone()),
                Some(format!("{} call", detected.display_name)),
            ) {
                log::warn!("Meeting auto-connect failed to start: {e}");
            }
        });
        *self.pending.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::MeetingAppPolicy;

    fn settings() -> MeetingSettings {
        MeetingSettings::default()
    }

    #[test]
    fn per_app_policy_overrides_the_global_default() {
        let mut s = settings();
        s.auto_connect = MeetingAutoConnect::Ask;
        s.app_policies.push(MeetingAppPolicy {
            bundle_id: "us.zoom.xos".into(),
            display_name: "Zoom".into(),
            policy: MeetingAutoConnect::Auto,
        });
        assert_eq!(policy_for(&s, "us.zoom.xos"), MeetingAutoConnect::Auto);
        assert_eq!(
            policy_for(&s, "com.tinyspeck.slackmacgap"),
            MeetingAutoConnect::Ask
        );
    }

    #[test]
    fn policy_lookup_is_case_insensitive() {
        let mut s = settings();
        s.app_policies.push(MeetingAppPolicy {
            bundle_id: "US.Zoom.XOS".into(),
            display_name: "Zoom".into(),
            policy: MeetingAutoConnect::Off,
        });
        assert_eq!(policy_for(&s, "us.zoom.xos"), MeetingAutoConnect::Off);
    }

    #[test]
    fn excluded_titles_match_case_insensitively() {
        let mut s = settings();
        s.excluded_title_patterns = vec!["therapy".into(), "1:1".into()];
        assert!(is_excluded(&s, Some("Weekly Therapy Session")));
        assert!(is_excluded(&s, Some("Alex 1:1")));
        assert!(!is_excluded(&s, Some("Team standup")));
        assert!(!is_excluded(&s, None));
    }

    #[test]
    fn blank_exclusion_patterns_never_match_everything() {
        let mut s = settings();
        s.excluded_title_patterns = vec!["   ".into(), "".into()];
        assert!(
            !is_excluded(&s, Some("Any meeting at all")),
            "an empty pattern must not exclude every meeting"
        );
    }

    #[test]
    fn user_policies_extend_the_known_app_list() {
        let mut s = settings();
        s.app_policies.push(MeetingAppPolicy {
            bundle_id: "com.example.newcall".into(),
            display_name: "NewCall".into(),
            policy: MeetingAutoConnect::Auto,
        });
        let apps = known_apps(&s);
        assert!(apps.iter().any(|(id, _)| id == "com.example.newcall"));
        // Built-ins survive.
        assert!(apps.iter().any(|(id, _)| id == "us.zoom.xos"));
    }

    #[test]
    fn helper_processes_count_as_the_parent_app() {
        // Electron apps open audio from a helper; detection must still fire.
        let active = vec!["com.tinyspeck.slackmacgap.helper".to_string()];
        assert!(crate::system_audio::is_bundle_capturing(
            "com.tinyspeck.slackmacgap",
            &active
        ));
    }

    #[test]
    fn similar_bundle_ids_do_not_collide() {
        let active = vec!["com.foo.barbaz".to_string()];
        assert!(!crate::system_audio::is_bundle_capturing(
            "com.foo.bar",
            &active
        ));
    }
}
