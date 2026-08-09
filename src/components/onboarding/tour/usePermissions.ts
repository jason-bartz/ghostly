import { useCallback, useEffect, useRef, useState } from "react";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  requestAccessibilityPermission,
  checkMicrophonePermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { commands } from "@/bindings";

export type PermissionStatus = "checking" | "needed" | "waiting" | "granted";

export interface PermissionsState {
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
}

/** Ghostly is macOS-only; anywhere else there is nothing to ask for. */
const isMac = () => {
  try {
    return platform() === "macos";
  } catch {
    return false;
  }
};

/**
 * Live macOS permission state.
 *
 * macOS grants these out of band — the user leaves for System Settings and
 * comes back — so there is no callback to await. Polling is the only honest
 * way to know, and it stops as soon as everything is granted or the poll
 * starts failing repeatedly.
 */
export function usePermissions() {
  const [state, setState] = useState<PermissionsState>({
    microphone: "checking",
    accessibility: "checking",
  });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorsRef = useRef(0);
  const initializedRef = useRef(false);

  const allGranted =
    state.microphone === "granted" && state.accessibility === "granted";
  const resolving =
    state.microphone === "checking" || state.accessibility === "checking";

  /** Enigo and the global shortcuts can only be set up once accessibility is
   *  granted — otherwise the shortcut silently never fires. */
  const initializeInput = useCallback(async () => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    try {
      await Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]);
    } catch (e) {
      console.warn("Failed to initialize input after permission grant:", e);
      initializedRef.current = false;
    }
  }, []);

  const read = useCallback(async (): Promise<PermissionsState | null> => {
    if (!isMac()) {
      return { microphone: "granted", accessibility: "granted" };
    }
    try {
      const [accessibility, microphone] = await Promise.all([
        checkAccessibilityPermission(),
        checkMicrophonePermission(),
      ]);
      if (accessibility) void initializeInput();
      return {
        microphone: microphone ? "granted" : "needed",
        accessibility: accessibility ? "granted" : "needed",
      };
    } catch (e) {
      console.warn("Failed to read macOS permissions:", e);
      return null;
    }
  }, [initializeInput]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current || !isMac()) return;
    pollRef.current = setInterval(async () => {
      const next = await read();
      if (!next) {
        errorsRef.current += 1;
        if (errorsRef.current >= 3) stopPolling();
        return;
      }
      errorsRef.current = 0;
      // Never walk a status backwards from "waiting" to "needed": the user is
      // mid-trip through System Settings and the card must not flicker.
      setState((prev) => ({
        microphone:
          next.microphone === "granted"
            ? "granted"
            : prev.microphone === "waiting"
              ? "waiting"
              : next.microphone,
        accessibility:
          next.accessibility === "granted"
            ? "granted"
            : prev.accessibility === "waiting"
              ? "waiting"
              : next.accessibility,
      }));
      if (next.microphone === "granted" && next.accessibility === "granted") {
        stopPolling();
      }
    }, 1000);
  }, [read, stopPolling]);

  // Initial read.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await read();
      if (cancelled) return;
      // An unreadable permission API is not a granted permission — show the
      // cards and let the user act rather than waving them through.
      setState(next ?? { microphone: "needed", accessibility: "needed" });
    })();
    return () => {
      cancelled = true;
    };
  }, [read]);

  // Keep polling while anything is outstanding, so a permission granted in
  // System Settings without pressing our button still resolves the step.
  useEffect(() => {
    if (resolving || allGranted) return;
    startPolling();
  }, [resolving, allGranted, startPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const request = useCallback(
    async (which: keyof PermissionsState) => {
      try {
        if (which === "microphone") {
          await requestMicrophonePermission();
        } else {
          await requestAccessibilityPermission();
        }
        setState((prev) => ({ ...prev, [which]: "waiting" }));
        startPolling();
      } catch (e) {
        console.warn(`Failed to request ${which} permission:`, e);
        setState((prev) => ({ ...prev, [which]: "needed" }));
      }
    },
    [startPolling],
  );

  return { state, allGranted, resolving, request };
}
