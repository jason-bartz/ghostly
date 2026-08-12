#ifndef app_identity_bridge_h
#define app_identity_bridge_h

#include <stdint.h>

// C-compatible declarations for the app-identity Swift bridge.
//
// Ghostly's existing app detection goes through `active-win-pos-rs`, which on
// macOS fills its `app_name` from `kCGWindowOwnerName` — a *display* name
// ("zoom.us", "Slack", "Messages"), not a bundle identifier. That value is
// stored in `AppContext.bundle_id`, so any comparison against a real bundle id
// such as `com.tinyspeck.slackmacgap` silently never matches.
//
// This bridge exposes NSWorkspace, which reports genuine bundle identifiers,
// and does so for *every* running application rather than only the frontmost
// one. Reading window titles for other apps requires Screen Recording
// permission; bundle identifiers do not.

#ifdef __cplusplus
extern "C" {
#endif

// Real bundle identifier of the frontmost application ("us.zoom.xos"), or NULL
// when there is none. Caller owns the string — release with
// ghostly_app_identity_free_string().
char *ghostly_frontmost_bundle_id(void);

// Localized display name of the frontmost application ("zoom.us"), or NULL.
// Caller owns the string.
char *ghostly_frontmost_display_name(void);

// Newline-separated `bundleId\tdisplayName` records for every running
// application with a regular activation policy (i.e. things with a UI, not
// daemons). Returns NULL only on failure; an empty result is an empty string.
// Caller owns the string.
char *ghostly_running_app_bundle_ids(void);

// 1 when an application with `bundle_id` is currently running.
int32_t ghostly_is_app_running(const char *bundle_id);

// Resolve a display name ("Slack") to its bundle identifier
// ("com.tinyspeck.slackmacgap") by scanning running applications. Returns NULL
// when no running app matches. Caller owns the string.
char *ghostly_bundle_id_for_display_name(const char *display_name);

// Newline-separated window titles for every running process with `bundle_id`.
// Uses the Accessibility API rather than Core Graphics: kCGWindowName needs
// Screen Recording permission, which Meeting Mode is built to avoid, while
// Ghostly already holds Accessibility for its global shortcuts.
//
// An empty string means either "no titled windows" or "Accessibility is not
// granted" — callers must not read it as "nothing matched". Check
// ghostly_accessibility_is_trusted() to tell the two apart. Caller owns the
// string.
char *ghostly_window_titles_for_bundle(const char *bundle_id);

// Newline-separated URLs of every web area belonging to `bundle_id`, most
// recently focused window first. Empty when the app is not a browser, has no
// open page, or Accessibility is not granted.
//
// Read from the Accessibility tree's AXWebArea (attribute AXURL), not
// AppleScript: scripting Chrome or Safari trips the Automation permission
// prompt and would put a second scary dialog in front of Meeting Mode, which
// exists precisely to need no new permissions. Every Chromium- and WebKit-based
// browser exposes AXURL, so one implementation covers Chrome, Safari, Arc, Dia,
// Edge, Brave and the rest.
//
// This is what lets a meeting in a browser tab be identified as Google Meet or
// Teams rather than as "Dia". Caller owns the string.
char *ghostly_web_urls_for_bundle(const char *bundle_id);

// 1 when the process is trusted for Accessibility. Never prompts.
int32_t ghostly_accessibility_is_trusted(void);

void ghostly_app_identity_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* app_identity_bridge_h */
