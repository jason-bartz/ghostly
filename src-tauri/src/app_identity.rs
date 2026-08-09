//! Real application identity via NSWorkspace.
//!
//! # Why this exists
//!
//! [`crate::frontmost`] uses `active-win-pos-rs`, which on macOS fills its
//! `app_name` from `kCGWindowOwnerName` — a *display* name. That value ends up
//! in `AppContext::bundle_id`, so it holds `"zoom.us"`, `"Slack"`,
//! `"Messages"`, never `us.zoom.xos`, `com.tinyspeck.slackmacgap`, or
//! `com.apple.MobileSMS`.
//!
//! Consequently every comparison in [`crate::profiles`] against a real bundle
//! id cannot match. Zoom appears to work only because its display name happens
//! to be spelled `zoom.us`.
//!
//! This module returns genuine bundle identifiers and, unlike the window-based
//! approach, needs no Screen Recording permission and can enumerate *every*
//! running app rather than just the frontmost one.

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::c_char;

    extern "C" {
        pub fn ghostly_frontmost_bundle_id() -> *mut c_char;
        pub fn ghostly_frontmost_display_name() -> *mut c_char;
        pub fn ghostly_running_app_bundle_ids() -> *mut c_char;
        pub fn ghostly_is_app_running(bundle_id: *const c_char) -> i32;
        pub fn ghostly_bundle_id_for_display_name(display_name: *const c_char) -> *mut c_char;
        pub fn ghostly_window_titles_for_bundle(bundle_id: *const c_char) -> *mut c_char;
        pub fn ghostly_accessibility_is_trusted() -> i32;
        pub fn ghostly_app_identity_free_string(value: *mut c_char);
    }
}

/// Takes ownership of a Swift-allocated C string and frees it.
#[cfg(target_os = "macos")]
fn consume_string(raw: *mut std::os::raw::c_char) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    unsafe {
        let value = std::ffi::CStr::from_ptr(raw).to_string_lossy().into_owned();
        ffi::ghostly_app_identity_free_string(raw);
        (!value.is_empty()).then_some(value)
    }
}

/// A running application with its genuine bundle identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningApp {
    pub bundle_id: String,
    pub display_name: String,
}

/// Bundle identifier of the frontmost application, e.g. `us.zoom.xos`.
pub fn frontmost_bundle_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        consume_string(unsafe { ffi::ghostly_frontmost_bundle_id() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Localized display name of the frontmost application, e.g. `zoom.us`.
pub fn frontmost_display_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        consume_string(unsafe { ffi::ghostly_frontmost_display_name() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Every running application that has a dock presence.
pub fn running_apps() -> Vec<RunningApp> {
    #[cfg(target_os = "macos")]
    {
        let Some(blob) = consume_string(unsafe { ffi::ghostly_running_app_bundle_ids() }) else {
            return Vec::new();
        };
        blob.lines()
            .filter_map(|line| {
                let (bundle_id, display_name) = line.split_once('\t')?;
                (!bundle_id.is_empty()).then(|| RunningApp {
                    bundle_id: bundle_id.to_string(),
                    display_name: display_name.to_string(),
                })
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Whether an app with this bundle identifier is running. Case-insensitive.
pub fn is_app_running(bundle_id: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(c_string) = std::ffi::CString::new(bundle_id) else {
            return false;
        };
        unsafe { ffi::ghostly_is_app_running(c_string.as_ptr()) == 1 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        false
    }
}

/// Resolves a Core Graphics owner name to a real bundle identifier by looking
/// it up among running applications.
///
/// This is the bridge between the legacy [`crate::frontmost::AppContext`] —
/// whose `bundle_id` field actually holds a display name — and code that needs
/// to match on genuine identifiers.
///
/// Results are memoised: a given display name maps to the same bundle id for as
/// long as that app is installed, and the uncached path walks the entire
/// running-application list. Callers on the transcription hot path (profile and
/// category resolution) hit this on every dictation.
pub fn bundle_id_for_display_name(display_name: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use std::collections::HashMap;
        use std::sync::{Mutex, OnceLock};

        static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));

        if let Ok(map) = cache.lock() {
            if let Some(hit) = map.get(display_name) {
                return hit.clone();
            }
        }

        let c_string = std::ffi::CString::new(display_name).ok()?;
        let resolved =
            consume_string(unsafe { ffi::ghostly_bundle_id_for_display_name(c_string.as_ptr()) });

        // A miss is cached too, but only when *something* is running — an empty
        // app list means we asked too early, and caching that would poison the
        // entry for the rest of the session.
        if resolved.is_some() || !running_apps().is_empty() {
            if let Ok(mut map) = cache.lock() {
                map.insert(display_name.to_string(), resolved.clone());
            }
        }
        resolved
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = display_name;
        None
    }
}

/// Window titles for every running process with this bundle identifier.
///
/// Zoom, Teams, Meet and Slack all put the meeting name in the window title, so
/// this is the only title source Meeting Mode has — and the one its exclusion
/// list depends on.
///
/// Reads through the Accessibility API, not Core Graphics: `kCGWindowName`
/// requires Screen Recording permission, which Meeting Mode exists to avoid,
/// while Ghostly already holds Accessibility for its global shortcuts.
///
/// Returns an empty vector both when the app has no titled windows and when
/// Accessibility has not been granted. Callers deciding whether to *suppress*
/// something must not read that as "no match" — use
/// [`accessibility_is_trusted`] to distinguish the two.
pub fn window_titles_for_bundle(bundle_id: &str) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Ok(c_string) = std::ffi::CString::new(bundle_id) else {
            return Vec::new();
        };
        let Some(blob) =
            consume_string(unsafe { ffi::ghostly_window_titles_for_bundle(c_string.as_ptr()) })
        else {
            return Vec::new();
        };
        blob.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
        Vec::new()
    }
}

/// Whether Ghostly is trusted for Accessibility. Never prompts.
pub fn accessibility_is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { ffi::ghostly_accessibility_is_trusted() == 1 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Best-effort real bundle id for an [`AppContext`](crate::frontmost::AppContext).
///
/// Prefers the frontmost app's true identifier when the context describes the
/// app that is currently focused, and otherwise resolves the stored display
/// name through the running-app list.
pub fn resolve_bundle_id(ctx: &crate::frontmost::AppContext) -> Option<String> {
    let name = ctx.bundle_id.as_deref().or(ctx.process_name.as_deref())?;

    // Fast path: the context usually describes the frontmost app, and comparing
    // display names avoids a full running-app scan.
    if let (Some(front_name), Some(front_id)) = (frontmost_display_name(), frontmost_bundle_id()) {
        if front_name.eq_ignore_ascii_case(name)
            || front_name.eq_ignore_ascii_case(name.trim_end_matches(".app"))
        {
            return Some(front_id);
        }
    }

    bundle_id_for_display_name(name)
}
