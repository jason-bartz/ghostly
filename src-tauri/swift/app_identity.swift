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

@_cdecl("ghostly_app_identity_free_string")
public func ghostlyAppIdentityFreeString(_ value: UnsafeMutablePointer<CChar>?) {
  guard let value else { return }
  free(value)
}
