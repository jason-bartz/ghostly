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

#[cfg(test)]
mod tests {
    use super::*;

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
