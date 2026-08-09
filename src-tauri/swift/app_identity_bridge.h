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

void ghostly_app_identity_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* app_identity_bridge_h */
