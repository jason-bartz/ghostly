import { useCallback, useEffect } from "react";
import type { Appearance } from "@/bindings";
import { useSettings } from "./useSettings";

/** The two themes that actually exist. `System` resolves to one of these. */
export type ResolvedTheme = "dark" | "light";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveAppearance(appearance: Appearance): ResolvedTheme {
  if (appearance === "system") return systemTheme();
  return appearance === "light" ? "light" : "dark";
}

/**
 * Write the resolved theme to `<html data-theme>`, which is what every CSS
 * token override keys off.
 *
 * The `data-theme-transition` attribute is added around the change and removed
 * a beat later. Leaving it on permanently would put a 220ms colour transition
 * on every element in the app forever, which makes hover states feel laggy;
 * applying it only during the swap gives a clean cross-fade and nothing else.
 */
function applyTheme(theme: ResolvedTheme, animate: boolean) {
  const root = document.documentElement;
  if (animate) {
    root.setAttribute("data-theme-transition", "");
    window.setTimeout(() => root.removeAttribute("data-theme-transition"), 260);
  }
  root.setAttribute("data-theme", theme);
}

/**
 * Mirror the *preference* (not the resolved theme) into localStorage so the
 * pre-paint script in index.html can apply it synchronously on the next
 * launch. Storing the preference rather than the resolution matters for
 * `system`: a user who switched their Mac to light overnight should come back
 * to a light app, not to yesterday's resolved dark.
 */
function cachePreference(appearance: Appearance) {
  try {
    localStorage.setItem("ghostly:theme", appearance);
  } catch {
    // Private mode / quota. The only cost is a first-paint flash.
  }
}

/**
 * Keeps the DOM theme in sync with the persisted preference, and — when the
 * preference is `system` — with the OS.
 *
 * Mount once, near the root.
 */
export function useAppearanceSync(): void {
  const { settings } = useSettings();
  const appearance: Appearance = settings?.appearance ?? "dark";

  useEffect(() => {
    const resolved = resolveAppearance(appearance);
    // Don't cross-fade when the pre-paint script already got it right — that
    // is the common case, and animating a no-op change is just a flicker.
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(resolved, current !== null && current !== resolved);
    cachePreference(appearance);
  }, [appearance]);

  useEffect(() => {
    if (appearance !== "system") return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => applyTheme(systemTheme(), true);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [appearance]);
}

/** Read + write the appearance preference. */
export function useAppearance() {
  const { settings, updateSetting } = useSettings();
  const appearance: Appearance = settings?.appearance ?? "dark";

  const setAppearance = useCallback(
    (next: Appearance) => void updateSetting("appearance", next),
    [updateSetting],
  );

  return { appearance, resolved: resolveAppearance(appearance), setAppearance };
}
