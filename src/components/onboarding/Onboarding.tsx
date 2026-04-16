import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Zap, Shield, MousePointerClick } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import type { ModelCardStatus } from "./ModelCard";
import ModelCard from "./ModelCard";
import GhostlyLogo from "../icons/GhostwriterLogo";
import { useModelStore } from "../../stores/modelStore";

interface OnboardingProps {
  onModelSelected: () => void;
}

const DEFAULT_MODEL_ID = "parakeet-tdt-0.6b-v3";

const Onboarding: React.FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();
  const {
    models,
    downloadModel,
    selectModel,
    downloadingModels,
    verifyingModels,
    extractingModels,
    downloadProgress,
    downloadStats,
  } = useModelStore();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const autoDownloadStartedRef = useRef(false);

  // Pick Parakeet V3 if present, otherwise fall back to the first recommended model.
  const targetModel: ModelInfo | undefined =
    models.find((m) => m.id === DEFAULT_MODEL_ID) ??
    models.find((m) => m.is_recommended);

  // Kick off the default download automatically once the model list is loaded.
  useEffect(() => {
    if (autoDownloadStartedRef.current) return;
    if (!targetModel) return;

    autoDownloadStartedRef.current = true;
    setSelectedModelId(targetModel.id);

    if (targetModel.is_downloaded) return;

    downloadModel(targetModel.id).then((success) => {
      if (!success) {
        autoDownloadStartedRef.current = false;
        setSelectedModelId(null);
      }
    });
  }, [targetModel, downloadModel]);

  useEffect(() => {
    if (!selectedModelId) return;

    const model = models.find((m) => m.id === selectedModelId);
    const stillDownloading = selectedModelId in downloadingModels;
    const stillVerifying = selectedModelId in verifyingModels;
    const stillExtracting = selectedModelId in extractingModels;

    if (
      model?.is_downloaded &&
      !stillDownloading &&
      !stillVerifying &&
      !stillExtracting
    ) {
      selectModel(selectedModelId).then((success) => {
        if (success) {
          onModelSelected();
        } else {
          toast.error(t("onboarding.errors.selectModel"));
          autoDownloadStartedRef.current = false;
          setSelectedModelId(null);
        }
      });
    }
  }, [
    selectedModelId,
    models,
    downloadingModels,
    verifyingModels,
    extractingModels,
    selectModel,
    onModelSelected,
    t,
  ]);

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) return "extracting";
    if (modelId in verifyingModels) return "verifying";
    if (modelId in downloadingModels) return "downloading";
    return "downloadable";
  };

  const features = [
    { Icon: Shield, text: t("onboarding.features.onDevice") },
    { Icon: Zap, text: t("onboarding.features.fast") },
    { Icon: MousePointerClick, text: t("onboarding.features.everywhere") },
  ];

  return (
    <div className="app-canvas h-screen w-screen flex flex-col p-6 gap-6 overflow-y-auto">
      {/* Hero */}
      <div className="aura-hero flex flex-col items-center gap-3 shrink-0 pt-6 text-center">
        <GhostlyLogo width={120} />
        <h1 className="text-3xl font-display text-text mt-2 leading-tight tracking-tight">
          {t("onboarding.title")}
        </h1>
        <p className="text-text-muted text-[13px] max-w-sm">
          {t("onboarding.tagline")}
        </p>
      </div>

      {/* Feature highlights */}
      <div className="max-w-[540px] w-full mx-auto flex flex-col gap-2">
        {features.map(({ Icon, text }, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-3 rounded-xl surface-card"
          >
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent/10 border border-accent/20 shrink-0">
              <Icon className="w-3.5 h-3.5 text-accent-bright" />
            </div>
            <span className="text-[13px] text-text-muted">{text}</span>
          </div>
        ))}
      </div>

      {/* Default model download */}
      <div className="max-w-[540px] w-full mx-auto flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="tag-pill">{t("onboarding.modelSection")}</span>
          <div className="flex-1 h-px bg-hairline" />
        </div>

        {targetModel && (
          <div className="flex flex-col gap-2">
            <ModelCard
              model={targetModel}
              variant="featured"
              status={getModelStatus(targetModel.id)}
              disabled
              onSelect={() => {}}
              downloadProgress={downloadProgress[targetModel.id]?.percentage}
              downloadSpeed={downloadStats[targetModel.id]?.speed}
            />
            <p className="text-xs text-text-faint px-1">
              {t("onboarding.recommendedReason")}
            </p>
            <p className="text-xs text-text-faint px-1">
              {t("onboarding.changeLaterHint")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Onboarding;
