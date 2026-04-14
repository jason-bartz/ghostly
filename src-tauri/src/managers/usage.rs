//! Weekly usage tracking for the free-tier cap.
//!
//! Free users get 30 minutes of successful transcription per ISO calendar
//! week (Monday 00:00 local time → next Monday 00:00 local). Pro users are
//! not capped but their totals are still recorded for the vanity stats shown
//! in the Usage settings pane.
//!
//! Persistence lives in the OS keychain (macOS Keychain via `keyring`) as a
//! single HMAC-signed JSON blob. Keychain survives app reinstall and deletes
//! of application support data, which raises the bar on trivial reset
//! exploits. An attacker can still patch the binary or write a fresh blob
//! with a valid HMAC (the secret is compiled in) — the goal is to make
//! honest purchase easier than a workaround, not to prevent a determined
//! cracker.

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, TimeZone, Weekday};
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::sync::Mutex;

/// Free-tier weekly limit: 30 minutes = 1800 seconds.
pub const FREE_WEEKLY_LIMIT_SECS: u64 = 30 * 60;

/// Fraction of the limit at which we emit a warning event (first crossing
/// per week). 0.8 = 80%.
pub const WARNING_THRESHOLD: f64 = 0.80;

/// Number of prior completed weeks to retain for the stats view.
const HISTORY_RETENTION_WEEKS: usize = 12;

/// Keychain service + account under which the blob is stored.
const KEYCHAIN_SERVICE: &str = "computer.ghostly.usage";
const KEYCHAIN_ACCOUNT: &str = "weekly_v1";

/// Compile-time HMAC secret. Not truly secret (anyone disassembling the
/// binary can find it), but combined with keychain-scoped storage it's a
/// meaningful deterrent to casual tampering.
const HMAC_SECRET: &[u8] = b"ghostly-usage-v1-21a4f8c9e0b6";

/// Serialized form persisted in the keychain.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct UsageBlob {
    version: u32,
    current_week_start: String, // "YYYY-MM-DD" (Monday, local)
    current_week_seconds: u64,
    /// Whether we've already emitted the 80% warning for this week.
    #[serde(default)]
    warned_this_week: bool,
    lifetime_seconds: u64,
    /// Completed weeks, newest first, capped to HISTORY_RETENTION_WEEKS.
    history: Vec<CompletedWeek>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct CompletedWeek {
    week_start: String,
    seconds: u64,
    hit_limit: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct UsageWeek {
    pub week_start_iso: String,
    pub seconds: u64,
    pub hit_limit: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct UsageStats {
    pub week_start_iso: String,
    pub seconds_used: u64,
    pub weekly_limit_secs: u64,
    pub is_pro: bool,
    pub is_over_limit: bool,
    pub is_at_warning: bool,
    /// Unix timestamp (seconds) when the current week resets (next Monday
    /// 00:00 local). Frontend computes "time remaining" from this.
    pub resets_at_unix: i64,
    pub lifetime_seconds: u64,
    pub history: Vec<UsageWeek>,
}

/// Returned by [`UsageManager::check_limit`] so callers can decide what to do
/// before starting a recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitCheck {
    /// Under the limit; proceed normally.
    Allowed,
    /// At or above 80% and have not warned yet this week; caller should emit
    /// a one-time warning event.
    FirstWarning,
    /// At or above 100% of the weekly limit; free-tier callers should block.
    OverLimit,
}

/// Thread-safe facade around the persisted usage blob. All methods take a
/// `&self` and serialize internal access through a mutex.
pub struct UsageManager {
    state: Mutex<UsageBlob>,
}

impl UsageManager {
    pub fn new() -> Self {
        let blob = load_blob().unwrap_or_else(|| {
            debug!("No existing usage blob found or HMAC invalid; starting fresh");
            fresh_blob()
        });
        Self {
            state: Mutex::new(blob),
        }
    }

    /// Roll the week forward if we've crossed a Monday boundary since the
    /// last write. Called implicitly by other methods; callers don't need
    /// to invoke it directly.
    fn rotate_if_needed(&self, blob: &mut UsageBlob) {
        let this_week = current_week_start_iso();
        if blob.current_week_start == this_week {
            return;
        }
        // Archive the completed week.
        let hit_limit = blob.current_week_seconds >= FREE_WEEKLY_LIMIT_SECS;
        let completed = CompletedWeek {
            week_start: blob.current_week_start.clone(),
            seconds: blob.current_week_seconds,
            hit_limit,
        };
        blob.history.insert(0, completed);
        if blob.history.len() > HISTORY_RETENTION_WEEKS {
            blob.history.truncate(HISTORY_RETENTION_WEEKS);
        }
        blob.current_week_start = this_week;
        blob.current_week_seconds = 0;
        blob.warned_this_week = false;
    }

    /// Check whether a new recording should be allowed, and whether we owe
    /// the caller a first-crossing warning. Does not mutate usage counters
    /// (those only move on successful transcriptions via `record`).
    pub fn check_limit(&self, is_pro: bool) -> LimitCheck {
        let mut blob = self.state.lock().expect("usage mutex poisoned");
        self.rotate_if_needed(&mut blob);
        if is_pro {
            return LimitCheck::Allowed;
        }
        if blob.current_week_seconds >= FREE_WEEKLY_LIMIT_SECS {
            return LimitCheck::OverLimit;
        }
        let threshold = (FREE_WEEKLY_LIMIT_SECS as f64 * WARNING_THRESHOLD) as u64;
        if blob.current_week_seconds >= threshold && !blob.warned_this_week {
            // Mark warned so the next check doesn't re-emit. Persist so the
            // flag survives restarts — this is the "first time this week"
            // event, not "first time this session."
            blob.warned_this_week = true;
            let snapshot = blob.clone();
            drop(blob);
            save_blob(&snapshot);
            return LimitCheck::FirstWarning;
        }
        LimitCheck::Allowed
    }

    /// Record a successful transcription's audio duration against this
    /// week's counter and the lifetime counter. Pro users are recorded too
    /// (for the vanity metric) but never trip the cap.
    pub fn record(&self, duration_secs: u64) {
        if duration_secs == 0 {
            return;
        }
        let snapshot = {
            let mut blob = self.state.lock().expect("usage mutex poisoned");
            self.rotate_if_needed(&mut blob);
            blob.current_week_seconds = blob.current_week_seconds.saturating_add(duration_secs);
            blob.lifetime_seconds = blob.lifetime_seconds.saturating_add(duration_secs);
            blob.clone()
        };
        save_blob(&snapshot);
    }

    /// Snapshot for the Usage settings pane. Always recomputes `is_over_limit`
    /// against the current value so the UI reflects reality even if `is_pro`
    /// changes at runtime.
    pub fn stats(&self, is_pro: bool) -> UsageStats {
        let mut blob = self.state.lock().expect("usage mutex poisoned");
        self.rotate_if_needed(&mut blob);
        let is_over_limit = !is_pro && blob.current_week_seconds >= FREE_WEEKLY_LIMIT_SECS;
        let warn_threshold = (FREE_WEEKLY_LIMIT_SECS as f64 * WARNING_THRESHOLD) as u64;
        let is_at_warning = !is_pro && blob.current_week_seconds >= warn_threshold;
        UsageStats {
            week_start_iso: blob.current_week_start.clone(),
            seconds_used: blob.current_week_seconds,
            weekly_limit_secs: FREE_WEEKLY_LIMIT_SECS,
            is_pro,
            is_over_limit,
            is_at_warning,
            resets_at_unix: next_week_start_unix(),
            lifetime_seconds: blob.lifetime_seconds,
            history: blob
                .history
                .iter()
                .map(|w| UsageWeek {
                    week_start_iso: w.week_start.clone(),
                    seconds: w.seconds,
                    hit_limit: w.hit_limit,
                })
                .collect(),
        }
    }
}

impl Default for UsageManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------- week math ----------

/// ISO date (YYYY-MM-DD) for Monday of the current local week.
fn current_week_start_iso() -> String {
    week_start_for(Local::now().date_naive())
}

fn week_start_for(date: NaiveDate) -> String {
    let days_from_monday = date.weekday().num_days_from_monday() as i64;
    let monday = date - ChronoDuration::days(days_from_monday);
    monday.format("%Y-%m-%d").to_string()
}

/// Unix seconds for next Monday 00:00 in the user's local timezone.
fn next_week_start_unix() -> i64 {
    let today = Local::now().date_naive();
    let days_until_monday = match today.weekday() {
        Weekday::Mon => 7,
        w => 7 - w.num_days_from_monday() as i64,
    };
    let next_monday = today + ChronoDuration::days(days_until_monday);
    let naive = next_monday
        .and_hms_opt(0, 0, 0)
        .expect("midnight is always valid");
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp())
        .unwrap_or_else(|| chrono::Utc::now().timestamp() + 7 * 24 * 3600)
}

// ---------- persistence ----------

fn fresh_blob() -> UsageBlob {
    UsageBlob {
        version: 1,
        current_week_start: current_week_start_iso(),
        current_week_seconds: 0,
        warned_this_week: false,
        lifetime_seconds: 0,
        history: Vec::new(),
    }
}

/// Wire format: `{ "blob": <UsageBlob>, "hmac": "<hex>" }`
#[derive(Serialize, Deserialize)]
struct SignedEnvelope {
    blob: UsageBlob,
    hmac: String,
}

fn compute_hmac(blob: &UsageBlob) -> String {
    // Plain keyed hash (not RFC-2104 HMAC), which is fine given the goal is
    // tamper detection, not authentication. Using sha2 directly keeps the
    // dependency footprint minimal — `sha2` is already in Cargo.toml.
    let payload = serde_json::to_vec(blob).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(HMAC_SECRET);
    hasher.update(&payload);
    hasher.update(HMAC_SECRET);
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn keychain_entry() -> Option<keyring::Entry> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(e) => Some(e),
        Err(err) => {
            warn!("Failed to open usage keychain entry: {}", err);
            None
        }
    }
}

fn load_blob() -> Option<UsageBlob> {
    let entry = keychain_entry()?;
    let raw = match entry.get_password() {
        Ok(s) => s,
        Err(keyring::Error::NoEntry) => return None,
        Err(err) => {
            warn!("Failed to read usage blob from keychain: {}", err);
            return None;
        }
    };
    let envelope: SignedEnvelope = match serde_json::from_str(&raw) {
        Ok(e) => e,
        Err(err) => {
            warn!("Usage blob is not valid JSON: {}", err);
            return None;
        }
    };
    let expected = compute_hmac(&envelope.blob);
    if expected != envelope.hmac {
        // Tamper / corruption. Treat as fresh-but-over-limit so we don't
        // accidentally reward tampering: if the blob says 0 and the real
        // value was 1800, returning 0 is worse than returning nothing.
        // Caller uses None -> fresh blob, so the user effectively gets a
        // reset week. This is the lesser evil; if abuse turns out to be
        // material, we switch to server-side enforcement.
        warn!("Usage blob HMAC mismatch; ignoring stored value");
        return None;
    }
    Some(envelope.blob)
}

fn save_blob(blob: &UsageBlob) {
    let Some(entry) = keychain_entry() else {
        return;
    };
    let envelope = SignedEnvelope {
        blob: blob.clone(),
        hmac: compute_hmac(blob),
    };
    let serialized = match serde_json::to_string(&envelope) {
        Ok(s) => s,
        Err(err) => {
            warn!("Failed to serialize usage blob: {}", err);
            return;
        }
    };
    if let Err(err) = entry.set_password(&serialized) {
        warn!("Failed to write usage blob to keychain: {}", err);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn week_start_returns_monday() {
        // 2026-04-14 is a Tuesday -> Monday is 2026-04-13.
        let tue = NaiveDate::from_ymd_opt(2026, 4, 14).unwrap();
        assert_eq!(week_start_for(tue), "2026-04-13");
        let mon = NaiveDate::from_ymd_opt(2026, 4, 13).unwrap();
        assert_eq!(week_start_for(mon), "2026-04-13");
        let sun = NaiveDate::from_ymd_opt(2026, 4, 19).unwrap();
        assert_eq!(week_start_for(sun), "2026-04-13");
    }

    #[test]
    fn hmac_detects_tamper() {
        let mut blob = fresh_blob();
        blob.current_week_seconds = 500;
        let h1 = compute_hmac(&blob);
        blob.current_week_seconds = 600;
        let h2 = compute_hmac(&blob);
        assert_ne!(h1, h2);
    }
}
