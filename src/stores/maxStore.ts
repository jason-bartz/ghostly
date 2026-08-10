import { create } from "zustand";
import { commands, type AiStatus, type LicenseState } from "@/bindings";

/**
 * Ghostly Max entitlement, shared across the settings panes that care.
 *
 * Two sources, deliberately kept apart:
 *
 *   `license` is the offline-verified token. It carries the tier, so the UI can
 *   decide *immediately and without a network call* whether to show the hosted
 *   provider or the bring-your-own-key configuration. Everything that gates
 *   layout reads this.
 *
 *   `aiStatus` is the gateway's own answer. It carries the numbers the token
 *   can't (requests used against the monthly allowance) and catches a lapse
 *   that happened after the token was minted. Everything that shows a count
 *   reads this, and tolerates it being null — offline is not an error state
 *   worth blocking the pane over.
 */
interface MaxState {
  license: LicenseState | null;
  aiStatus: AiStatus | null;
  /** Set when `/ai/status` could not be reached; the pane degrades, not fails. */
  aiStatusError: string | null;
  loading: boolean;

  /** Refresh the licence token view. Cheap and local. */
  refreshLicense: () => Promise<LicenseState>;
  /** Refresh entitlement + quota from the gateway. Network. */
  refreshAiStatus: () => Promise<void>;
  /**
   * Both, in the order the UI needs them. Safe to call from every pane's mount
   * effect — a fetch newer than {@link STATUS_TTL_MS} is reused rather than
   * repeated, so flipping between panes doesn't hit the gateway each time.
   * `force` bypasses that, for the licence-changed path where the cached
   * answer is known to be stale.
   */
  refresh: (force?: boolean) => Promise<void>;
}

export const MAX_TIER = "max";

/** How long a `/ai/status` answer is considered fresh enough to reuse. */
const STATUS_TTL_MS = 30_000;

let lastStatusFetchAt = 0;

export const useMaxStore = create<MaxState>((set, get) => ({
  license: null,
  aiStatus: null,
  aiStatusError: null,
  loading: false,

  refreshLicense: async () => {
    const license = await commands.getLicenseState();
    set({ license });
    return license;
  },

  refreshAiStatus: async () => {
    lastStatusFetchAt = Date.now();
    const result = await commands.getAiStatus();
    if (result.status === "ok") {
      set({ aiStatus: result.data, aiStatusError: null });
    } else {
      // Includes the ordinary "no licence on this device" case, which is not
      // worth surfacing — the caller decides based on the licence state.
      set({ aiStatus: null, aiStatusError: String(result.error.code) });
    }
  },

  refresh: async (force = false) => {
    set({ loading: true });
    try {
      const license = await get().refreshLicense();
      if (!license.is_licensed) {
        lastStatusFetchAt = 0;
        set({ aiStatus: null, aiStatusError: null });
        return;
      }
      const fresh = Date.now() - lastStatusFetchAt < STATUS_TTL_MS;
      if (force || !fresh) {
        await get().refreshAiStatus();
      }
    } finally {
      set({ loading: false });
    }
  },
}));

/** True when this install is entitled to hosted AI, per the offline token. */
export const isMaxLicense = (license: LicenseState | null): boolean =>
  license?.is_licensed === true && license.tier === MAX_TIER;
