import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { toast } from "sonner";
import { Ban, Check, Key, Loader2, Sparkles } from "lucide-react";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import { StepHeader } from "../parts";
import type { TourStepProps } from "../types";

type Choice = "apple_intelligence" | "byok" | "none";

const APPLE_PROVIDER_ID = "apple_intelligence";
const DEFAULT_BYOK_PROVIDER_ID = "openai";

/**
 * Refinement, sold before it's configured.
 *
 * The old screen led with three provider names, which asks the user to choose
 * an implementation before they know what the feature does. The before/after
 * sample above the options answers "what am I choosing?" in one glance, and
 * the choice applies the moment it's made — no separate save.
 */
export const RefinementStep: React.FC<TourStepProps> = ({ setFooter }) => {
  const { t } = useTranslation();
  const setPostProcessProvider = useSettingsStore(
    (state) => state.setPostProcessProvider,
  );
  const refreshSettings = useSettingsStore((state) => state.refreshSettings);
  const updateSetting = useSettingsStore((state) => state.updateSetting);

  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Choice | null>(null);
  const [applying, setApplying] = useState<Choice | null>(null);

  // Apple Intelligence needs recent hardware and an opted-in OS; anywhere else
  // the option simply doesn't appear rather than appearing and failing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (platform() !== "macos") {
          if (!cancelled) setAppleAvailable(false);
          return;
        }
        const available = await commands.checkAppleIntelligenceAvailable();
        if (!cancelled) setAppleAvailable(available);
      } catch (e) {
        console.warn("Failed to check Apple Intelligence availability:", e);
        if (!cancelled) setAppleAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setFooter({ hint: t("tour.refinement.changeLater") });
  }, [setFooter, t]);

  const apply = async (choice: Choice) => {
    if (applying) return;
    setSelected(choice);
    setApplying(choice);
    try {
      if (choice === "none") {
        await updateSetting("refinement_enabled", false);
      } else {
        await updateSetting("refinement_enabled", true);
        await setPostProcessProvider(
          choice === "apple_intelligence"
            ? APPLE_PROVIDER_ID
            : DEFAULT_BYOK_PROVIDER_ID,
        );
        await refreshSettings();
      }
    } catch (e) {
      console.error("Failed to apply refinement choice:", e);
      toast.error(t("tour.refinement.saveFailed"));
      setSelected(null);
    } finally {
      setApplying(null);
    }
  };

  if (appleAvailable === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-accent-bright" />
      </div>
    );
  }

  const options: Array<{
    id: Choice;
    Icon: typeof Sparkles;
    badge?: string;
    show: boolean;
  }> = [
    {
      id: "apple_intelligence",
      Icon: Sparkles,
      badge: t("tour.refinement.options.apple_intelligence.badge"),
      show: appleAvailable,
    },
    { id: "byok", Icon: Key, show: true },
    { id: "none", Icon: Ban, show: true },
  ];

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        eyebrow={t("tour.refinement.eyebrow")}
        title={t("tour.refinement.title")}
        body={t("tour.refinement.body")}
      />

      {/* What refinement actually does, in the user's own idiom. */}
      <div
        data-rise
        style={{ "--i": 1 } as React.CSSProperties}
        className="surface-card-inlay px-4 py-3 grid grid-cols-[1fr_auto_1fr] items-start gap-3"
      >
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint mb-1.5">
            {t("tour.refinement.sample.beforeLabel")}
          </p>
          <p className="text-[12px] leading-snug text-text-subtle">
            {t("tour.refinement.sample.before")}
          </p>
        </div>
        <Sparkles className="w-4 h-4 mt-3 text-accent-bright shrink-0" />
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-bright mb-1.5">
            {t("tour.refinement.sample.afterLabel")}
          </p>
          <p className="text-[12px] leading-snug text-text">
            {t("tour.refinement.sample.after")}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {options
          .filter((option) => option.show)
          .map((option, i) => {
            const active = selected === option.id;
            const Icon = option.Icon;
            return (
              <button
                key={option.id}
                type="button"
                data-rise
                style={{ "--i": 2 + i } as React.CSSProperties}
                onClick={() => void apply(option.id)}
                className={`w-full text-start px-4 py-2.5 rounded-xl border transition-all duration-200 cursor-pointer ${
                  active
                    ? "bg-accent/[0.09] border-accent/45"
                    : "surface-card hover:border-hairline-strong hover:bg-fill-2"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`flex items-center justify-center w-8 h-8 rounded-lg shrink-0 border transition-colors ${
                      active
                        ? "bg-accent/15 border-accent/35"
                        : "bg-fill-2 border-hairline"
                    }`}
                  >
                    <Icon
                      className={`w-4 h-4 ${active ? "text-accent-bright" : "text-text-subtle"}`}
                    />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-text">
                        {t(`tour.refinement.options.${option.id}.title`)}
                      </p>
                      {option.badge && (
                        <span className="tag tag-accent">{option.badge}</span>
                      )}
                    </div>
                    <p className="text-[12px] text-text-muted leading-snug mt-0.5">
                      {t(`tour.refinement.options.${option.id}.body`)}
                    </p>
                  </div>
                  <span className="shrink-0 self-center w-4">
                    {applying === option.id ? (
                      <Loader2 className="w-4 h-4 animate-spin text-accent-bright" />
                    ) : active ? (
                      <Check className="w-4 h-4 text-accent-bright" />
                    ) : null}
                  </span>
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
};

export default RefinementStep;
