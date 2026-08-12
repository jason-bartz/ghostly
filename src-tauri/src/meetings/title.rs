//! What a meeting is called before anyone renames it.
//!
//! One shape, `"{platform} meeting - {MM/DD/YY}"`, used by every path that
//! starts a meeting: auto-detection, the panel button, the tray item and the
//! global shortcut. They used to disagree — detection produced "Zoom call" or
//! whatever the window title happened to say, while a manual start produced
//! nothing at all and the meeting showed up as "Untitled meeting".

use chrono::Local;

/// `"Google Meet meeting - 08/12/26"`.
///
/// The date is the *local* date, because it names the day the user had the
/// meeting, not the day UTC thought it was.
pub fn default_title(platform: &str) -> String {
    stamped_title(platform, Local::now().format("%m/%d/%y").to_string())
}

/// Split out so the format is testable without freezing the clock.
fn stamped_title(platform: &str, date: String) -> String {
    let platform = platform.trim();
    if platform.is_empty() {
        // Nothing identified the app — better a dated meeting than an
        // "Untitled meeting" that sorts identically to every other one.
        return format!("Meeting - {date}");
    }
    format!("{platform} meeting - {date}")
}

/// Ghostly's own bundle identifier, which is never the platform of a meeting.
///
/// Pressing "Start meeting" in the panel, or picking it out of the tray, makes
/// Ghostly the frontmost app at the moment capture begins — so the obvious
/// implementation names every hand-started meeting "Ghostly meeting".
const SELF_BUNDLE_ID: &str = "com.getghostly.desktop";

/// The title for a meeting started by hand, from whatever app was in front.
///
/// The frontmost app is a weaker signal than a detected call — the user may
/// simply have had a browser focused — so an unrecognised browser page falls
/// back to the browser's own name rather than being discarded. Ghostly itself
/// is discarded, leaving a plain dated title.
pub fn for_frontmost_app(bundle_id: Option<&str>, display_name: Option<&str>) -> String {
    if bundle_id.is_some_and(|id| id.eq_ignore_ascii_case(SELF_BUNDLE_ID)) {
        return default_title("");
    }
    let platform = match (bundle_id, display_name) {
        (Some(bundle_id), Some(display_name)) => {
            super::platform::resolve(bundle_id, display_name).unwrap_or_else(|| display_name.into())
        }
        (_, Some(display_name)) => display_name.to_string(),
        _ => String::new(),
    };
    default_title(&platform)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_platform_and_the_date() {
        assert_eq!(
            stamped_title("Google Meet", "08/12/26".to_string()),
            "Google Meet meeting - 08/12/26"
        );
    }

    #[test]
    fn falls_back_when_nothing_is_identified() {
        assert_eq!(
            stamped_title("", "08/12/26".to_string()),
            "Meeting - 08/12/26"
        );
        assert_eq!(
            stamped_title("   ", "08/12/26".to_string()),
            "Meeting - 08/12/26"
        );
    }

    #[test]
    fn a_generated_title_is_produced_for_every_start_path() {
        // Only that it is non-empty and dated — the date itself is `now`.
        let title = for_frontmost_app(Some("us.zoom.xos"), Some("Zoom"));
        assert!(title.starts_with("Zoom meeting - "), "got {title}");

        let unknown = for_frontmost_app(None, None);
        assert!(unknown.starts_with("Meeting - "), "got {unknown}");
    }

    #[test]
    fn ghostly_never_names_a_meeting_after_itself() {
        // Starting from the panel button or the tray makes Ghostly frontmost,
        // which would otherwise produce "Ghostly meeting - 08/12/26".
        let title = for_frontmost_app(Some(SELF_BUNDLE_ID), Some("Ghostly"));
        assert!(title.starts_with("Meeting - "), "got {title}");
        // The dev build reports the same id under a lowercased name.
        let dev = for_frontmost_app(Some("com.getghostly.desktop"), Some("ghostly"));
        assert!(dev.starts_with("Meeting - "), "got {dev}");
    }
}
