//! Which service a call is actually on.
//!
//! The bundle identifier answers "what program is capturing the microphone",
//! which for a native client is the same question — `us.zoom.xos` is Zoom. For
//! a browser it is not: a Google Meet call, a Teams call and a Slack huddle held
//! in tabs are all indistinguishably "Dia", or "Arc", or "Google Chrome". That
//! is what the user saw, and it told them nothing about the meeting they had
//! just recorded.
//!
//! So for browsers the platform is resolved from the page URL, read out of the
//! Accessibility tree by [`crate::app_identity::web_urls_for_bundle`]. Only the
//! host is matched, never the path: hosts are stable, while the path components
//! of a meeting URL are room ids that change every call.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Browsers, where the app name is not the platform and the URL has to be
/// consulted.
///
/// Matched by prefix so channel builds — `com.google.Chrome.beta`,
/// `org.mozilla.firefoxdeveloperedition` — resolve the same as the release.
const BROWSER_BUNDLE_PREFIXES: &[&str] = &[
    "com.google.chrome",
    "com.apple.safari",
    "company.thebrowser.", // Arc (`.Browser`) and Dia (`.dia`)
    "com.brave.browser",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
    "app.zen-browser.zen",
    "com.sigmaos.sigmaos",
];

/// Host suffix to platform name.
///
/// Suffixes, so `meet.google.com` and any regional or tenant subdomain both
/// resolve. Ordered longest-first at match time so `teams.live.com` is not
/// shadowed by a shorter entry.
const HOST_PLATFORMS: &[(&str, &str)] = &[
    ("meet.google.com", "Google Meet"),
    ("teams.microsoft.com", "Microsoft Teams"),
    ("teams.live.com", "Microsoft Teams"),
    ("zoom.us", "Zoom"),
    ("slack.com", "Slack"),
    ("discord.com", "Discord"),
    ("webex.com", "Webex"),
    ("whereby.com", "Whereby"),
    ("meet.jit.si", "Jitsi"),
    ("gather.town", "Gather"),
    ("around.co", "Around"),
    ("riverside.fm", "Riverside"),
    ("app.chime.aws", "Amazon Chime"),
    ("chime.aws", "Amazon Chime"),
    ("bluejeans.com", "BlueJeans"),
    ("gotomeeting.com", "GoToMeeting"),
    ("meet.hey.com", "HEY"),
    ("huddle01.com", "Huddle01"),
    ("livestorm.co", "Livestorm"),
    ("demio.com", "Demio"),
    ("butter.us", "Butter"),
    ("tldv.io", "tl;dv"),
    ("pop.com", "Pop"),
    ("tuple.app", "Tuple"),
    ("meet.wa.me", "WhatsApp"),
    ("web.whatsapp.com", "WhatsApp"),
    ("messenger.com", "Messenger"),
    ("app.pumble.com", "Pumble"),
    ("venue.live", "Venue"),
    ("dialpad.com", "Dialpad"),
    ("ringcentral.com", "RingCentral"),
    ("8x8.vc", "8x8"),
    ("talk.brave.com", "Brave Talk"),
];

/// Whether this app's platform has to be read from a URL rather than its name.
pub fn is_browser(bundle_id: &str) -> bool {
    let lowered = bundle_id.to_ascii_lowercase();
    BROWSER_BUNDLE_PREFIXES
        .iter()
        .any(|prefix| lowered.starts_with(prefix))
}

/// The meeting platform a URL belongs to, or `None` for an ordinary page.
///
/// Only the host is inspected. A meeting URL's path is a room id —
/// `meet.google.com/abc-defg-hij` — which is different every call and useless
/// for identification.
pub fn platform_for_url(url: &str) -> Option<&'static str> {
    let host = host_of(url)?;

    // Longest suffix wins, so `teams.live.com` cannot be shadowed by a shorter
    // entry that also happens to match.
    HOST_PLATFORMS
        .iter()
        .filter(|(suffix, _)| host == *suffix || host.ends_with(&format!(".{suffix}")))
        .max_by_key(|(suffix, _)| suffix.len())
        .map(|(_, name)| *name)
}

/// Lowercased host of an `http(s)` URL, without port or credentials.
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // Credentials, if any, sit before the last '@'.
    let authority = authority.rsplit('@').next()?;
    let host = authority.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// How long a browser's resolved platform is reused before looking again.
///
/// The detector polls every three seconds, and reading a URL is not a cheap
/// read: it is a synchronous Accessibility call into *another* process, walking
/// that app's element tree. Doing it every three seconds for the whole length
/// of a call — into a browser that is simultaneously rendering video — is a
/// tax for no benefit, because the answer only changes when the user moves to
/// a different call, and starting a meeting is not that time-critical.
const URL_CACHE_TTL: Duration = Duration::from_secs(30);

type UrlCache = Mutex<HashMap<String, (Instant, Option<&'static str>)>>;

/// The platform for an app: read from its open pages when it is a browser,
/// otherwise the app's own name.
///
/// Returns `None` for a browser with no recognisable meeting open — the caller
/// then has to decide whether "Dia" is a useful thing to call the meeting, and
/// for detection it is a signal that this may not be a meeting at all.
pub fn resolve(bundle_id: &str, display_name: &str) -> Option<String> {
    if !is_browser(bundle_id) {
        return Some(display_name.to_string());
    }

    static CACHE: OnceLock<UrlCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = bundle_id.to_ascii_lowercase();

    // A miss is cached as readily as a hit: "this browser has no call open" is
    // the answer during every poll of an ordinary working day, and it is the
    // expensive one to compute.
    if let Ok(map) = cache.lock() {
        if let Some((read_at, platform)) = map.get(&key) {
            if read_at.elapsed() < URL_CACHE_TTL {
                return platform.map(str::to_string);
            }
        }
    }

    let platform = crate::app_identity::web_urls_for_bundle(bundle_id)
        .iter()
        .find_map(|url| platform_for_url(url));

    if let Ok(mut map) = cache.lock() {
        map.insert(key, (Instant::now(), platform));
    }
    platform.map(str::to_string)
}

/// The platform a meeting should be filed under, for a meeting being started.
///
/// [`resolve`] answers with the app's own display name for a native client,
/// and that name is whatever the process calls itself — Zoom's is `zoom.us`.
/// The built-in list of conferencing apps carries the name people actually
/// use, so a known bundle id is looked up there first. Browsers still go
/// through the URL, and a browser with no recognisable call open is not a
/// platform at all: "Dia" is where the meeting was, not what it was.
pub fn canonical(bundle_id: Option<&str>, display_name: Option<&str>) -> Option<String> {
    if let Some(bundle_id) = bundle_id {
        if is_browser(bundle_id) {
            return resolve(bundle_id, display_name.unwrap_or_default());
        }
        if let Some(name) = known_app_name(bundle_id) {
            return Some(name.to_string());
        }
    }
    display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// The curated name of a built-in conferencing app, by bundle id.
fn known_app_name(bundle_id: &str) -> Option<&'static str> {
    crate::settings::MEETING_APP_BUNDLE_IDS
        .iter()
        .find(|(id, _)| id.eq_ignore_ascii_case(bundle_id))
        .map(|(_, name)| *name)
}

/// The platform of a meeting recorded before platforms were stored.
///
/// Those rows only kept the platform as the prefix of their placeholder title,
/// `"Google Meet meeting - 08/12/26"`. That is the best evidence when it is
/// still there, because for a browser call it is the only record of which
/// service the tab was on. Failing that — the meeting was renamed — a native
/// app is still its own platform; a browser is not, and is left unlabelled
/// rather than called "Chrome".
pub fn infer_for_record(
    bundle_id: Option<&str>,
    display_name: Option<&str>,
    title: Option<&str>,
) -> Option<String> {
    if let Some(prefix) = title.and_then(placeholder_platform) {
        return Some(prefix.to_string());
    }
    match bundle_id {
        Some(id) if is_browser(id) => None,
        Some(id) => known_app_name(id)
            .map(str::to_string)
            .or_else(|| display_name.map(str::to_string)),
        None => None,
    }
    .filter(|name| !name.trim().is_empty())
}

/// `"Google Meet"` out of `"Google Meet meeting - 08/12/26"`.
fn placeholder_platform(title: &str) -> Option<&str> {
    let (platform, date) = title.rsplit_once(" meeting - ")?;
    let is_date = date.len() == 8
        && date.chars().enumerate().all(|(i, c)| {
            if i == 2 || i == 5 {
                c == '/'
            } else {
                c.is_ascii_digit()
            }
        });
    (is_date && !platform.trim().is_empty()).then_some(platform.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_native_app_is_filed_under_the_name_people_use() {
        // Zoom's own process name is `zoom.us`, which is what a manual start
        // from the frontmost app would otherwise record.
        assert_eq!(
            canonical(Some("us.zoom.xos"), Some("zoom.us")),
            Some("Zoom".to_string())
        );
        assert_eq!(
            canonical(Some("com.example.unknown"), Some("Some App")),
            Some("Some App".to_string())
        );
        assert_eq!(canonical(None, None), None);
        assert_eq!(canonical(None, Some("  ")), None);
    }

    #[test]
    fn older_meetings_recover_their_platform_from_the_placeholder_title() {
        assert_eq!(
            infer_for_record(
                Some("com.google.Chrome"),
                Some("Google Chrome"),
                Some("Google Meet meeting - 08/12/26")
            ),
            Some("Google Meet".to_string())
        );
        // Renamed browser meeting: the browser is not a platform.
        assert_eq!(
            infer_for_record(
                Some("com.google.Chrome"),
                Some("Google Chrome"),
                Some("Acme sync")
            ),
            None
        );
        // Renamed native meeting: the app still is.
        assert_eq!(
            infer_for_record(Some("us.zoom.xos"), Some("zoom.us"), Some("Acme sync")),
            Some("Zoom".to_string())
        );
        // A hand-typed name that merely contains "meeting -" is not a placeholder.
        assert_eq!(
            infer_for_record(None, None, Some("Weekly meeting - planning")),
            None
        );
        assert_eq!(
            infer_for_record(None, None, Some("Meeting - 08/12/26")),
            None
        );
    }

    #[test]
    fn recognises_browsers_including_channel_builds() {
        assert!(is_browser("company.thebrowser.dia"));
        assert!(is_browser("company.thebrowser.Browser"));
        assert!(is_browser("com.google.Chrome"));
        assert!(is_browser("com.google.Chrome.beta"));
        assert!(is_browser("com.apple.Safari"));
        assert!(!is_browser("us.zoom.xos"));
        assert!(!is_browser("com.tinyspeck.slackmacgap"));
    }

    #[test]
    fn maps_meeting_hosts_to_platforms() {
        assert_eq!(
            platform_for_url("https://meet.google.com/abc-defg-hij"),
            Some("Google Meet")
        );
        assert_eq!(
            platform_for_url("https://teams.microsoft.com/l/meetup-join/19%3ameeting"),
            Some("Microsoft Teams")
        );
        assert_eq!(
            platform_for_url("https://acme.slack.com/huddle/T0001/C0002"),
            Some("Slack")
        );
        assert_eq!(
            platform_for_url("https://acme.zoom.us/j/1234567890?pwd=xyz"),
            Some("Zoom")
        );
    }

    #[test]
    fn ignores_ordinary_pages() {
        assert_eq!(platform_for_url("https://news.ycombinator.com/"), None);
        assert_eq!(platform_for_url("https://github.com/anthropics"), None);
        // A page that merely mentions a platform in its path is not a call.
        assert_eq!(
            platform_for_url("https://example.com/zoom.us/pricing"),
            None
        );
    }

    #[test]
    fn ignores_non_http_urls() {
        assert_eq!(platform_for_url("about:blank"), None);
        assert_eq!(platform_for_url("file:///Users/x/notes.html"), None);
        assert_eq!(platform_for_url(""), None);
    }

    #[test]
    fn host_parsing_strips_port_and_credentials() {
        assert_eq!(
            host_of("https://user:pw@Meet.Google.com:443/x"),
            Some("meet.google.com".to_string())
        );
        assert_eq!(
            host_of("http://example.com"),
            Some("example.com".to_string())
        );
    }

    #[test]
    fn a_native_app_is_its_own_platform() {
        assert_eq!(
            resolve("us.zoom.xos", "Zoom"),
            Some("Zoom".to_string()),
            "a native client needs no URL lookup"
        );
    }
}
