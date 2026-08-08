import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Bot, Check, Shield, Zap } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import { commands } from "@/bindings";
import GhostlyLogo from "../icons/GhostwriterLogo";
import { Button } from "../ui/Button";
import { useModelStore } from "../../stores/modelStore";
import { useSettings } from "../../hooks/useSettings";

interface OnboardingProps {
  onModelSelected: () => void;
}

/** The tier we install for new users, in the background. */
const UPGRADE_MODEL_ID = "parakeet-tdt-0.6b-v3";

/**
 * First run.
 *
 * The previous version of this screen was a gate: it started a 456 MB download
 * and the user waited, watching a progress bar, before they could do anything.
 * That is the worst first impression in this category — cloud competitors are
 * dictating in twenty seconds.
 *
 * A starter model now ships inside the app bundle, so dictation works
 * immediately. This screen therefore says so, starts the better model
 * downloading in the background, and gets out of the way. Nothing here blocks.
 */
const Onboarding: React.FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const {
    models,
    downloadModel,
    selectModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
  } = useModelStore();

  const [optInReports, setOptInReports] = useState(false);
  const downloadStartedRef = useRef(false);
  const upgradeAppliedRef = useRef(false);

  const upgradeModel: ModelInfo | undefined = useMemo(
    () =>
      models.find((m) => m.id === UPGRADE_MODEL_ID) ??
      models.find((m) => m.is_recommended),
    [models],
  );

  const shortcut = settings?.bindings?.transcribe?.current_binding ?? "";

  // Start the upgrade download immediately, but never wait on it.
  useEffect(() => {
    if (downloadStartedRef.current || !upgradeModel) return;
    downloadStartedRef.current = true;
    if (upgradeModel.is_downloaded) return;
    void downloadModel(upgradeModel.id);
  }, [upgradeModel, downloadModel]);

  // When the upgrade finishes — which may well be after the user has already
  // left this screen — switch to it silently.
  useEffect(() => {
    if (upgradeAppliedRef.current || !upgradeModel) return;
    const busy =
      upgradeModel.id in downloadingModels ||
      upgradeModel.id in verifyingModels ||
      upgradeModel.id in extractingModels;
    if (upgradeModel.is_downloaded && !busy) {
      upgradeAppliedRef.current = true;
      void selectModel(upgradeModel.id);
    }
  }, [
    upgradeModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
  ]);

  const progress = upgradeModel
    ? (downloadProgress[upgradeModel.id]?.percentage ?? 0)
    : 0;
  const upgradeReady = upgradeModel?.is_downloaded ?? false;

  const handleContinue = async () => {
    if (optInReports) {
      await commands.changeErrorReportingSetting(true);
    } else {
      await commands.markErrorReportingPrompted();
    }
    await commands.completeOnboarding();
    onModelSelected();
  };

  const points = [
    { Icon: Shield, key: "onDevice" },
    { Icon: Zap, key: "fast" },
    { Icon: Bot, key: "agents" },
  ];

  return (
    <div className="app-canvas h-screen w-screen flex flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-[560px] px-6 py-10 flex flex-col gap-7">
        {/* Hero */}
        <div className="aura-hero flex flex-col items-center gap-3 text-center">
          <GhostlyLogo width={112} />
          <h1 className="text-[34px] font-display leading-[1.05] tracking-tight mt-1 shimmer-text">
            {t("onboarding.title")}
          </h1>
          {/* The tagline is the product's whole promise, so it gets display
              type and the serif italic rather than being body copy. */}
          <p className="text-[15px] text-text-muted max-w-[26rem] leading-relaxed">
            {t("onboarding.tagline")}
          </p>
        </div>

        {/* The headline promise: you can already use this. */}
        <div className="section-band-accent flex flex-col items-center gap-2.5 text-center">
          <span className="tag-pill">
            <Check className="w-2.5 h-2.5" />
            {t("onboarding.ready.badge")}
          </span>
          <p className="text-[15px] font-display tracking-tight text-text">
            {shortcut
              ? t("onboarding.ready.headlineWithShortcut", { shortcut })
              : t("onboarding.ready.headline")}
          </p>
          <p className="text-[12.5px] text-text-muted leading-relaxed max-w-[24rem]">
            {t("onboarding.ready.body")}
          </p>
        </div>

        {/* Value points */}
        <div className="flex flex-col gap-2">
          {points.map(({ Icon, key }) => (
            <div
              key={key}
              className="flex items-center gap-3 px-4 py-3 rounded-xl surface-card"
            >
              <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent/10 border border-accent/20 shrink-0">
                <Icon className="w-3.5 h-3.5 text-accent-bright" />
              </span>
              <span className="text-[13px] text-text-muted leading-snug">
                {t(`onboarding.features.${key}`)}
              </span>
            </div>
          ))}
        </div>

        {/* Background upgrade — informational, never a gate. */}
        {upgradeModel && !upgradeReady && (
          <div className="rounded-xl surface-card px-4 py-3">
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-[12.5px] font-medium text-text">
                {t("onboarding.upgrade.title")}
              </p>
              <span className="text-[11px] tabular-nums text-text-faint">
                {`${Math.round(progress)}%`}
              </span>
            </div>
            <div className="w-full h-1 bg-fill-4 rounded-full overflow-hidden">
              <div
                className="h-full min-w-[2px] bg-gradient-to-r from-accent to-accent-deep rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-[11.5px] text-text-faint leading-snug mt-2">
              {t("onboarding.upgrade.body")}
            </p>
          </div>
        )}

        {/* One-time, unchecked, with the promise stated inline. */}
        <label className="flex items-start gap-2.5 px-1 cursor-pointer group">
          <input
            type="checkbox"
            checked={optInReports}
            onChange={(e) => setOptInReports(e.target.checked)}
            className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded accent-[var(--color-accent-deep)] cursor-pointer"
          />
          <span className="text-[11.5px] text-text-faint leading-relaxed group-hover:text-text-muted transition-colors">
            {t("onboarding.errorReports")}
          </span>
        </label>

        <Button
          variant="primary"
          size="lg"
          onClick={() => void handleContinue()}
          className="w-full gap-2"
        >
          {t("onboarding.ready.cta")}
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

export default Onboarding;
