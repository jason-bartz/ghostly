//! Dictation milestones — "you've spoken the length of ___".
//!
//! The table is embedded from `shared/milestones.json`, the same file the
//! sidebar imports (see `src/lib/constants/milestones.ts`). Detection has to
//! live here rather than in React because the settings window is closed most
//! of the time — the app runs from the tray, so a frontend-owned check would
//! only fire for users who happened to have settings open when they crossed
//! a threshold.
//!
//! Only entries flagged `notable` post a notification. The sidebar advances
//! through all ~284 of them, but the first five sit at 107–116 words, and
//! notifying on those would mean five banners in someone's first minute of
//! dictating. The flagged subset is famous enough to be worth an interruption
//! and spaced widely enough to stay rare.

use crate::notification_i18n::get_notification_translations;
use crate::settings;
use serde::Deserialize;
use std::sync::OnceLock;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Embedded at compile time, so there is no resource to ship or path to
/// resolve at runtime — and a malformed table fails `cargo test`, not a user's
/// launch.
const MILESTONES_JSON: &str = include_str!("../../shared/milestones.json");

#[derive(Debug, Clone, Deserialize)]
pub struct Milestone {
    /// Cumulative lifetime words needed to reach this milestone.
    pub words: u64,
    pub title: String,
    /// Whether the count is a published estimate rather than a measured
    /// edition, which softens the notification copy to "about the length of".
    #[serde(default)]
    pub approx: bool,
    /// Whether crossing this milestone is worth a notification.
    #[serde(default)]
    pub notable: bool,
}

fn table() -> &'static [Milestone] {
    static TABLE: OnceLock<Vec<Milestone>> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(MILESTONES_JSON).unwrap_or_else(|err| {
            // Unreachable in a build that passed `milestones_table_parses`.
            // Degrade to an empty table rather than panicking on the audio
            // thread: losing a vanity notification beats losing a dictation.
            log::error!("milestones.json failed to parse: {err}");
            Vec::new()
        })
    })
}

/// The highest *notable* milestone in `(previous, current]`.
///
/// Returns the highest rather than every crossing so a single long
/// transcription — or a backlog flushed at once — produces one banner instead
/// of a stack of them. Notable thresholds are far enough apart that crossing
/// two at once is already unlikely; this just makes it harmless.
pub fn notable_crossed(previous: u64, current: u64) -> Option<&'static Milestone> {
    if current <= previous {
        return None;
    }
    table()
        .iter()
        .rfind(|m| m.notable && m.words > previous && m.words <= current)
}

/// Post the "you've dictated the length of ___" banner for a crossed
/// milestone, unless the user has turned milestone notifications off.
///
/// Failures are logged and swallowed. This runs on the tail of a finished
/// transcription, and a notification that macOS declined to show is never
/// worth surfacing as an error to someone who just wanted their text pasted.
///
/// The OS permission prompt is deliberately left to the first real crossing
/// rather than requested at launch: by the time anyone reaches a notable
/// threshold they have used the app in earnest, so the prompt arrives with
/// context instead of during onboarding.
pub fn announce(app: &AppHandle, milestone: &Milestone) {
    let settings = settings::get_settings(app);
    if !settings.milestone_notifications {
        return;
    }

    let strings = get_notification_translations(Some(settings.app_language.clone()));
    let title = strings
        .milestone_title
        .replace("{{count}}", &format_thousands(milestone.words));
    // Series totals and reference works are published estimates, so the
    // celebratory copy hedges rather than asserting a precision the number
    // doesn't have.
    let template = if milestone.approx {
        &strings.milestone_body_approx
    } else {
        &strings.milestone_body
    };
    let body = template.replace("{{title}}", &milestone.title);

    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        log::warn!("Failed to show milestone notification: {err}");
    }
}

/// `48196` → `"48,196"`. Notification text is composed here rather than in the
/// frontend, so it can't lean on `Intl.NumberFormat`.
fn format_thousands(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The embedded JSON is only parsed lazily at runtime, so without this the
    /// first sign of a malformed table would be a silent loss of milestones in
    /// a shipped build.
    #[test]
    fn milestones_table_parses() {
        assert!(
            table().len() > 200,
            "expected the full table, got {}",
            table().len()
        );
        assert!(table().iter().any(|m| m.notable), "no notable milestones");
    }

    /// `notable_crossed` scans from the back for the highest match, so the
    /// table must be sorted; the TypeScript side asserts the same invariant in
    /// `milestones.test.ts`.
    #[test]
    fn table_is_sorted_and_unique() {
        let words: Vec<u64> = table().iter().map(|m| m.words).collect();
        let mut sorted = words.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(words, sorted, "milestones.json must be sorted and unique");
    }

    #[test]
    fn notable_crossed_finds_the_boundary() {
        // The Great Gatsby sits at 48,196 and is flagged notable.
        let hit = notable_crossed(48_000, 48_500).expect("should cross Gatsby");
        assert_eq!(hit.title, "The Great Gatsby");
        // Landing exactly on the threshold counts as crossing it.
        assert!(notable_crossed(48_195, 48_196).is_some());
        // Already past it, so no repeat.
        assert!(notable_crossed(48_196, 48_500).is_none());
    }

    #[test]
    fn notable_crossed_coalesces_to_the_highest() {
        // A jump spanning several notable thresholds yields exactly one, the
        // furthest along — not one banner per threshold.
        let hit = notable_crossed(0, 1_000_000).expect("should cross many");
        let highest = table()
            .iter()
            .rfind(|m| m.notable && m.words <= 1_000_000)
            .unwrap();
        assert_eq!(hit.words, highest.words);
    }

    #[test]
    fn no_crossing_when_total_did_not_move() {
        assert!(notable_crossed(500_000, 500_000).is_none());
        assert!(notable_crossed(500_000, 400_000).is_none());
    }

    #[test]
    fn thousands_separator() {
        assert_eq!(format_thousands(0), "0");
        assert_eq!(format_thousands(999), "999");
        assert_eq!(format_thousands(1_000), "1,000");
        assert_eq!(format_thousands(48_196), "48,196");
        assert_eq!(format_thousands(59_000_000), "59,000,000");
    }

    /// Notable milestones are the ones that interrupt someone, so they need to
    /// stay both famous and rare.
    ///
    /// "Rare" needs two rules, because neither works alone. A pure ratio is
    /// too strict at the top — 481k → 563k is only 1.17×, but it is 82,000
    /// words, which is three weeks of heavy dictation. A pure word gap is
    /// meaningless at the bottom, where the first two notables are 272 and
    /// 1,075 apart and the user should absolutely get both on day one. So a
    /// threshold qualifies on either: a real step up in ratio, or a big enough
    /// absolute gap that a heavy day (~4,000 words) can't span two.
    const MIN_RATIO: f64 = 1.25;
    const MIN_ABSOLUTE_GAP: u64 = 30_000;

    #[test]
    fn notable_milestones_are_spaced_out() {
        let notable: Vec<u64> = table()
            .iter()
            .filter(|m| m.notable)
            .map(|m| m.words)
            .collect();
        assert!(notable.len() >= 20, "expected a long tail of notables");
        for pair in notable.windows(2) {
            let (prev, next) = (pair[0], pair[1]);
            let by_ratio = next as f64 >= prev as f64 * MIN_RATIO;
            let by_gap = next >= prev + MIN_ABSOLUTE_GAP;
            assert!(
                by_ratio || by_gap,
                "notable milestones {prev} and {next} are too close: \
                 {:.2}× apart and only {} words",
                next as f64 / prev as f64,
                next - prev
            );
        }
    }
}
