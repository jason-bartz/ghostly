import { create } from "zustand";
import { check, Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
  percent: number;
}

interface UpdaterState {
  status: UpdaterStatus;
  available: AvailableUpdate | null;
  progress: DownloadProgress | null;
  error: string | null;
  lastCheckedAt: number | null;
  modalOpen: boolean;

  check: (options?: { silent?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restartNow: () => Promise<void>;
  skipCurrent: () => void;
  remindLater: () => void;
  openModal: () => void;
  closeModal: () => void;
}

const SKIPPED_VERSION_KEY = "ghostly:updater:skippedVersion";
const LAST_PROMPTED_KEY = "ghostly:updater:lastPromptedVersion";

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore (private mode, quota, etc.)
  }
};

let currentUpdate: Update | null = null;

export const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  status: "idle",
  available: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
  modalOpen: false,

  check: async ({ silent = false } = {}) => {
    const state = get();
    if (state.status === "checking" || state.status === "downloading") {
      return;
    }
    set({ status: "checking", error: null });
    try {
      const update = await check();
      set({ lastCheckedAt: Date.now() });

      if (!update) {
        currentUpdate = null;
        set({ status: "up-to-date", available: null, progress: null });
        return;
      }

      currentUpdate = update;
      const available: AvailableUpdate = {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body ?? null,
        date: update.date ?? null,
      };

      set({ status: "available", available, progress: null });

      if (silent) {
        const skipped = readStorage(SKIPPED_VERSION_KEY);
        const lastPrompted = readStorage(LAST_PROMPTED_KEY);
        if (skipped !== update.version && lastPrompted !== update.version) {
          writeStorage(LAST_PROMPTED_KEY, update.version);
          set({ modalOpen: true });
        }
      } else {
        set({ modalOpen: true });
      }
    } catch (err) {
      console.error("Update check failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      set({
        status: "error",
        error: message,
        lastCheckedAt: Date.now(),
      });
    }
  },

  downloadAndInstall: async () => {
    const update = currentUpdate;
    if (!update) return;

    set({
      status: "downloading",
      error: null,
      progress: { downloaded: 0, total: null, percent: 0 },
    });

    let total = 0;
    let downloaded = 0;

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          set({
            progress: {
              downloaded: 0,
              total: total || null,
              percent: 0,
            },
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
          set({
            progress: {
              downloaded,
              total: total || null,
              percent,
            },
          });
        } else if (event.event === "Finished") {
          set({
            status: "ready",
            progress: {
              downloaded,
              total: total || null,
              percent: 100,
            },
          });
        }
      });

      // downloadAndInstall installs and returns; mark ready for relaunch.
      if (get().status !== "ready") {
        set({ status: "ready" });
      }
    } catch (err) {
      console.error("Update install failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: message, progress: null });
    }
  },

  restartNow: async () => {
    try {
      await relaunch();
    } catch (err) {
      console.error("Relaunch failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: message });
    }
  },

  skipCurrent: () => {
    const available = get().available;
    if (available) {
      writeStorage(SKIPPED_VERSION_KEY, available.version);
    }
    set({ modalOpen: false });
  },

  remindLater: () => {
    set({ modalOpen: false });
  },

  openModal: () => {
    if (get().available) set({ modalOpen: true });
  },

  closeModal: () => set({ modalOpen: false }),
}));
