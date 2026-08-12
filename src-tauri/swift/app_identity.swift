import AppKit
import Foundation

// MARK: - Real application identity via NSWorkspace
//
// See swift/app_identity_bridge.h for why this exists: the Rust side's
// `AppContext.bundle_id` actually holds a Core Graphics *owner name*, so it
// cannot be compared against real bundle identifiers. NSWorkspace reports the
// genuine value and covers every running app, not just the frontmost one.
//
// Every function here is safe to call from any thread. NSWorkspace's
// `runningApplications` and `frontmostApplication` are main-thread-affine in
// principle but documented as safe to read from background threads; we avoid
// dispatching to main so a capture thread can never deadlock against the UI.

private func duplicateCString(_ text: String) -> UnsafeMutablePointer<CChar>? {
  return text.withCString { strdup($0) }
}

/// Apps with a dock presence. Filters out daemons, agents, and helper
/// processes that would otherwise dominate the list.
private func regularRunningApps() -> [NSRunningApplication] {
  return NSWorkspace.shared.runningApplications.filter {
    $0.activationPolicy == .regular
  }
}

@_cdecl("ghostly_frontmost_bundle_id")
public func ghostlyFrontmostBundleID() -> UnsafeMutablePointer<CChar>? {
  guard let bundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier else {
    return nil
  }
  return duplicateCString(bundleID)
}

@_cdecl("ghostly_frontmost_display_name")
public func ghostlyFrontmostDisplayName() -> UnsafeMutablePointer<CChar>? {
  guard let name = NSWorkspace.shared.frontmostApplication?.localizedName else {
    return nil
  }
  return duplicateCString(name)
}

@_cdecl("ghostly_running_app_bundle_ids")
public func ghostlyRunningAppBundleIDs() -> UnsafeMutablePointer<CChar>? {
  // `bundleId\tdisplayName` per line. Tab-separated because display names may
  // contain almost anything except control characters, and a tab keeps the
  // Rust-side split trivial and allocation-light.
  let lines = regularRunningApps().compactMap { app -> String? in
    guard let bundleID = app.bundleIdentifier else { return nil }
    let name = app.localizedName ?? ""
    return "\(bundleID)\t\(name)"
  }
  return duplicateCString(lines.joined(separator: "\n"))
}

@_cdecl("ghostly_is_app_running")
public func ghostlyIsAppRunning(_ bundleID: UnsafePointer<CChar>?) -> Int32 {
  guard let bundleID else { return 0 }
  let target = String(cString: bundleID)
  guard !target.isEmpty else { return 0 }
  // Not filtered to `.regular`: a conferencing app may briefly present as an
  // accessory while its call window is detached.
  let running = NSWorkspace.shared.runningApplications.contains {
    $0.bundleIdentifier?.caseInsensitiveCompare(target) == .orderedSame
  }
  return running ? 1 : 0
}

@_cdecl("ghostly_bundle_id_for_display_name")
public func ghostlyBundleIDForDisplayName(_ displayName: UnsafePointer<CChar>?)
  -> UnsafeMutablePointer<CChar>?
{
  guard let displayName else { return nil }
  let target = String(cString: displayName)
  guard !target.isEmpty else { return nil }

  // Core Graphics owner names sometimes carry the ".app" suffix while
  // NSWorkspace never does, so compare against both spellings.
  let normalized = target.hasSuffix(".app") ? String(target.dropLast(4)) : target

  let match = regularRunningApps().first { app in
    guard let name = app.localizedName else { return false }
    return name.caseInsensitiveCompare(target) == .orderedSame
      || name.caseInsensitiveCompare(normalized) == .orderedSame
  }
  guard let bundleID = match?.bundleIdentifier else { return nil }
  return duplicateCString(bundleID)
}

// MARK: - Window titles via the Accessibility API
//
// Deliberately not Core Graphics. `CGWindowListCopyWindowInfo`'s `kCGWindowName`
// has required Screen Recording permission since Catalina, and Meeting Mode's
// whole premise is that it needs no such permission — no capture indicator, no
// scary prompt. The Accessibility API returns the same title and Ghostly
// already holds that permission for its global shortcuts.
//
// This is what makes the "never auto-connect for 1:1 / therapy / interview"
// exclusion list work: Zoom, Teams, Meet and Slack all put the meeting name in
// the window title.

/// Titles of every window belonging to `app`, best effort.
///
/// Returns an empty array when Accessibility permission has not been granted,
/// which the caller must treat as "unknown", never as "no match".
private func windowTitles(for app: NSRunningApplication) -> [String] {
  let element = AXUIElementCreateApplication(app.processIdentifier)

  var windowsValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windowsValue)
      == .success,
    let windows = windowsValue as? [AXUIElement]
  else {
    return []
  }

  return windows.compactMap { window in
    var titleValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue) == .success,
      let title = titleValue as? String,
      !title.isEmpty
    else {
      return nil
    }
    return title
  }
}

@_cdecl("ghostly_window_titles_for_bundle")
public func ghostlyWindowTitlesForBundle(_ bundleID: UnsafePointer<CChar>?)
  -> UnsafeMutablePointer<CChar>?
{
  guard let bundleID else { return nil }
  let target = String(cString: bundleID)
  guard !target.isEmpty else { return nil }

  // Not filtered to `.regular`: the same reasoning as ghostly_is_app_running —
  // a call window can be owned by a process presenting as an accessory.
  let apps = NSWorkspace.shared.runningApplications.filter {
    $0.bundleIdentifier?.caseInsensitiveCompare(target) == .orderedSame
  }

  var titles: [String] = []
  for app in apps {
    titles.append(contentsOf: windowTitles(for: app))
  }
  // Newline-separated; titles cannot contain newlines.
  return duplicateCString(titles.joined(separator: "\n"))
}

// MARK: - Browser URLs via the Accessibility API
//
// A meeting held in a browser tab is indistinguishable from any other window if
// all you have is the bundle identifier: it reports "Dia", "Arc" or "Google
// Chrome" whether the user is in a Google Meet call or reading the news. The
// page URL is the thing that actually says which platform the call is on.
//
// Read through AXWebArea's AXURL rather than by scripting the browser.
// AppleScript against Chrome or Safari requires Automation permission, and a
// second consent dialog is exactly what Meeting Mode is designed to avoid;
// Ghostly already holds Accessibility. Chromium and WebKit both expose AXURL,
// so this covers every browser worth covering with one implementation.

/// How deep to search a window for its web area.
///
/// Browsers bury the content view a few groups down from the window, and the
/// depth differs between Chromium and WebKit. Six is comfortably past every
/// layout observed and still bounded — an unbounded walk of a browser's
/// Accessibility tree can visit every DOM node on the page.
private let maxWebAreaDepth = 6

/// Children scanned per element. A window has a handful of structural
/// children; anything with hundreds is page content, not chrome.
private let maxChildrenPerElement = 24

/// Depth-first search for the first `AXWebArea` under `element`.
private func findWebArea(_ element: AXUIElement, depth: Int) -> AXUIElement? {
  var roleValue: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue) == .success,
    let role = roleValue as? String, role == "AXWebArea"
  {
    return element
  }

  guard depth < maxWebAreaDepth else { return nil }

  var childrenValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
      == .success,
    let children = childrenValue as? [AXUIElement]
  else {
    return nil
  }

  for child in children.prefix(maxChildrenPerElement) {
    if let found = findWebArea(child, depth: depth + 1) {
      return found
    }
  }
  return nil
}

/// The URL currently loaded in `window`'s web area, if it has one.
private func webURL(for window: AXUIElement) -> String? {
  guard let webArea = findWebArea(window, depth: 0) else { return nil }

  var urlValue: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(webArea, kAXURLAttribute as CFString, &urlValue) == .success
  else {
    return nil
  }
  // Chromium hands back an NSURL; WebKit sometimes hands back a string.
  if let url = urlValue as? NSURL {
    return url.absoluteString
  }
  return urlValue as? String
}

@_cdecl("ghostly_web_urls_for_bundle")
public func ghostlyWebURLsForBundle(_ bundleID: UnsafePointer<CChar>?)
  -> UnsafeMutablePointer<CChar>?
{
  guard let bundleID else { return nil }
  let target = String(cString: bundleID)
  guard !target.isEmpty else { return nil }

  let apps = NSWorkspace.shared.runningApplications.filter {
    $0.bundleIdentifier?.caseInsensitiveCompare(target) == .orderedSame
  }

  var urls: [String] = []
  for app in apps {
    let element = AXUIElementCreateApplication(app.processIdentifier)

    var windowsValue: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXWindowsAttribute as CFString, &windowsValue)
        == .success,
      let windows = windowsValue as? [AXUIElement]
    else {
      continue
    }

    // AXWindows is ordered front to back, so the window the user is actually
    // looking at comes first — which is the one whose URL should win.
    for window in windows {
      if let url = webURL(for: window), !url.isEmpty {
        urls.append(url)
      }
    }
  }
  // Newline-separated; URLs cannot contain a raw newline.
  return duplicateCString(urls.joined(separator: "\n"))
}

@_cdecl("ghostly_accessibility_is_trusted")
public func ghostlyAccessibilityIsTrusted() -> Int32 {
  // No prompt: this is a read of current state, called from a polling loop.
  return AXIsProcessTrusted() ? 1 : 0
}

@_cdecl("ghostly_app_identity_free_string")
public func ghostlyAppIdentityFreeString(_ value: UnsafeMutablePointer<CChar>?) {
  guard let value else { return }
  free(value)
}
