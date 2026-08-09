import { useEffect } from "react";

/**
 * Keeps the panel's theme in step with the main window.
 *
 * The pre-paint script in `index.html` handles the *initial* value. This
 * handles changes made while the panel is already open: `useAppearanceSync`
 * writes the preference to localStorage, which fires a `storage` event in every
 * other window of the same origin. The media-query listener covers the
 * "system" preference following the OS.
 *
 * Deliberately not routed through `useSettings` — that store subscribes without
 * a selector, so every transcript chunk would re-render the whole panel.
 */
const STORAGE_KEY = "ghostly:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function resolve(preference: string | null): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  if (preference === "system") {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  }
  return "dark";
}

function apply(preference: string | null) {
  document.documentElement.setAttribute("data-theme", resolve(preference));
}

export function usePanelTheme(): void {
  useEffect(() => {
    apply(localStorage.getItem(STORAGE_KEY));

    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEY) {
        apply(localStorage.getItem(STORAGE_KEY));
      }
    };
    const media = window.matchMedia(DARK_QUERY);
    const onSystemChange = () => {
      // Only relevant while the preference is "system"; re-resolving is cheap
      // and avoids duplicating the preference check.
      apply(localStorage.getItem(STORAGE_KEY));
    };

    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onSystemChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onSystemChange);
    };
  }, []);
}
