import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Deep links into the macOS Privacy & Security panes.
 *
 * macOS only ever prompts for a permission once. After the first "Don't Allow"
 * the request API returns immediately and silently, so a dead end here is a
 * dead end in the product — System Settings is the only remaining route, and
 * telling someone to go and find it themselves is not a route.
 */
const PANES = {
  microphone:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
} as const;

export type PrivacyPane = keyof typeof PANES;

/**
 * Opens a privacy pane. Best-effort: the URL scheme is unavailable in a browser
 * dev server and can be refused by the OS, neither of which is worth surfacing
 * — the surrounding UI always explains what to do by hand as well.
 */
export async function openPrivacySettings(pane: PrivacyPane): Promise<void> {
  try {
    await openUrl(PANES[pane]);
  } catch (e) {
    console.warn(`Could not open the ${pane} privacy settings:`, e);
  }
}
