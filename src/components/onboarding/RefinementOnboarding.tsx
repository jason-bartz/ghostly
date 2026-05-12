import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { Sparkles, Key, Ban, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import GhostlyLogo from "../icons/GhostwriterLogo";

interface RefinementOnboardingProps {
  onComplete: () => void;
}

type Choice = "apple_intelligence" | "byok" | "none";

const APPLE_PROVIDER_ID = "apple_intelligence";
const DEFAULT_BYOK_PROVIDER_ID = "openai";

const RefinementOnboarding: React.FC<RefinementOnboardingProps> = ({
  onComplete,
}) => {
  const { t } = useTranslation();
  const setPostProcessProvider = useSettingsStore(
    (state) => state.setPostProcessProvider,
  );
  const refreshSettings = useSettingsStore((state) => state.refreshSettings);
  const updateSetting = useSettingsStore((state) => state.updateSetting);

  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<Choice | null>(null);
  const [applying, setApplying] = useState(false);

  // Detect Apple Intelligence availability on mount. Non-ARM64 macOS and other
  // platforms always report false, so the recommended option just won't show.
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

  // Default the recommended option once we know whether AI is available.
  useEffect(() => {
    if (appleAvailable === null || selected !== null) return;
    setSelected(appleAvailable ? "apple_intelligence" : "byok");
  }, [appleAvailable, selected]);

  const handleContinue = async () => {
    if (!selected || applying) return;
    setApplying(true);
    try {
      if (selected === "none") {
        await updateSetting("refinement_enabled", false);
      } else {
        await updateSetting("refinement_enabled", true);
        const providerId =
          selected === "apple_intelligence"
            ? APPLE_PROVIDER_ID
            : DEFAULT_BYOK_PROVIDER_ID;
        await setPostProcessProvider(providerId);
        await refreshSettings();
      }
      onComplete();
    } catch (e) {
      console.error("Failed to apply refinement choice:", e);
      toast.error(t("onboarding.refinement.errors.saveFailed"));
    } finally {
      setApplying(false);
    }
  };

  if (appleAvailable === null) {
    return (
      <div className="app-canvas h-screen w-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-accent-bright" />
      </div>
    );
  }

  const options: Array<{
    id: Choice;
    Icon: typeof Sparkles;
    title: string;
    description: string;
    badge?: string;
    show: boolean;
  }> = [
    {
      id: "apple_intelligence",
      Icon: Sparkles,
      title: t("onboarding.refinement.options.apple.title"),
      description: t("onboarding.refinement.options.apple.description"),
      badge: t("onboarding.refinement.options.apple.badge"),
      show: appleAvailable,
    },
    {
      id: "byok",
      Icon: Key,
      title: t("onboarding.refinement.options.byok.title"),
      description: t("onboarding.refinement.options.byok.description"),
      show: true,
    },
    {
      id: "none",
      Icon: Ban,
      title: t("onboarding.refinement.options.none.title"),
      description: t("onboarding.refinement.options.none.description"),
      show: true,
    },
  ];

  const visibleOptions = options.filter((o) => o.show);

  return (
    <div className="app-canvas h-screen w-screen flex flex-col p-6 gap-6 items-center overflow-y-auto">
      <div className="aura-hero flex flex-col items-center gap-3 shrink-0 pt-6 text-center">
        <GhostlyLogo width={120} className="max-w-full" />
        <h1 className="text-3xl font-display text-text mt-2 leading-tight tracking-tight">
          {t("onboarding.refinement.title")}
        </h1>
        <p className="text-text-muted text-[13px] max-w-md">
          {t("onboarding.refinement.tagline")}
        </p>
      </div>

      <div
        role="radiogroup"
        aria-label={t("onboarding.refinement.title")}
        className="max-w-[540px] w-full flex flex-col gap-3"
      >
        {visibleOptions.map(({ id, Icon, title, description, badge }) => {
          const isSelected = selected === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => setSelected(id)}
              className={`text-left flex items-start gap-3 px-4 py-3 rounded-xl surface-card transition-all border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                isSelected
                  ? "border-accent ring-2 ring-accent/30"
                  : "border-transparent hover:border-hairline-strong"
              }`}
            >
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 shrink-0 mt-0.5">
                <Icon
                  className="w-4 h-4 text-accent-bright"
                  aria-hidden="true"
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <h3 className="font-medium text-text text-[14px]">{title}</h3>
                  {badge && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-accent-deep/30 border border-accent/30 text-accent-bright">
                      {badge}
                    </span>
                  )}
                </div>
                <p className="text-[12.5px] text-text-muted leading-snug">
                  {description}
                </p>
              </div>
              {isSelected && (
                <Check
                  className="w-4 h-4 text-accent-bright shrink-0 mt-1"
                  aria-label={t("common.selected")}
                />
              )}
            </button>
          );
        })}

        <p className="text-xs text-text-faint px-1 mt-1">
          {t("onboarding.refinement.changeLaterHint")}
        </p>

        <button
          onClick={handleContinue}
          disabled={!selected || applying}
          className="self-center mt-2 px-5 py-2 rounded-full bg-accent-deep hover:bg-background-ui-hover text-white text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 transition-colors btn-glow disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {applying
            ? t("onboarding.refinement.applying")
            : t("onboarding.refinement.continue")}
        </button>
      </div>
    </div>
  );
};

export default RefinementOnboarding;
