import { useEffect, useMemo, useRef } from "react";
import type { ModelInfo } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";

/** The tier new users are moved to, once it has quietly finished downloading. */
const UPGRADE_MODEL_ID = "parakeet-tdt-0.6b-v3";

export interface ModelUpgradeState {
  /** Percentage of the background download, 0–100. */
  progress: number;
  /** True once the better model is installed and selected. */
  ready: boolean;
  /** False when there is nothing to download (already installed, or unknown). */
  active: boolean;
}

/**
 * The model upgrade, run behind the tour.
 *
 * A starter model ships in the app bundle, so dictation works from the first
 * second — which means the better model must never be a gate. It downloads
 * while the user reads, and swaps itself in when it's done, possibly long
 * after they've left onboarding entirely. Nothing waits on it.
 */
export function useModelUpgrade(enabled: boolean): ModelUpgradeState {
  const {
    models,
    downloadModel,
    selectModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
  } = useModelStore();

  const startedRef = useRef(false);
  const appliedRef = useRef(false);

  const upgrade: ModelInfo | undefined = useMemo(
    () =>
      models.find((m) => m.id === UPGRADE_MODEL_ID) ??
      models.find((m) => m.is_recommended),
    [models],
  );

  useEffect(() => {
    if (!enabled || startedRef.current || !upgrade) return;
    startedRef.current = true;
    if (upgrade.is_downloaded) return;
    void downloadModel(upgrade.id);
  }, [enabled, upgrade, downloadModel]);

  useEffect(() => {
    if (!enabled || appliedRef.current || !upgrade) return;
    const busy =
      upgrade.id in downloadingModels ||
      upgrade.id in verifyingModels ||
      upgrade.id in extractingModels;
    if (upgrade.is_downloaded && !busy) {
      appliedRef.current = true;
      void selectModel(upgrade.id);
    }
  }, [
    enabled,
    upgrade,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
  ]);

  return {
    progress: upgrade ? (downloadProgress[upgrade.id]?.percentage ?? 0) : 0,
    ready: upgrade?.is_downloaded ?? false,
    active: Boolean(upgrade) && !(upgrade?.is_downloaded ?? false),
  };
}
