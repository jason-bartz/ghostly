import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Zap, Shield, MousePointerClick } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import type { ModelCardStatus } from "./ModelCard";
import ModelCard from "./ModelCard";
import GhostlyLogo from "../icons/GhostwriterLogo";
import { useModelStore } from "../../stores/modelStore";

interface OnboardingProps {
  onModelSelected: () => void;
}

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
  const [showMoreModels, setShowMoreModels] = useState(false);

  const isDownloading = selectedModelId !== null;

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
  ]);

  const handleDownloadModel = async (modelId: string) => {
    setSelectedModelId(modelId);
    const success = await downloadModel(modelId);
    if (!success) {
      setSelectedModelId(null);
    }
  };

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) return "extracting";
    if (modelId in verifyingModels) return "verifying";
    if (modelId in downloadingModels) return "downloading";
    return "downloadable";
  };

  const getModelDownloadProgress = (modelId: string): number | undefined => {
    return downloadProgress[modelId]?.percentage;
  };

  const getModelDownloadSpeed = (modelId: string): number | undefined => {
    return downloadStats[modelId]?.speed;
  };

  const notDownloaded = models.filter((m: ModelInfo) => !m.is_downloaded);
  const recommendedModels = notDownloaded.filter((m: ModelInfo) => m.is_recommended);
  const otherModels = notDownloaded
    .filter((m: ModelInfo) => !m.is_recommended)
    .sort((a: ModelInfo, b: ModelInfo) => Number(a.size_mb) - Number(b.size_mb));

  const features = [
    { Icon: Shield, text: t("onboarding.features.onDevice") },
    { Icon: Zap, text: t("onboarding.features.fast") },
    { Icon: MousePointerClick, text: t("onboarding.features.everywhere") },
  ];

  return (
    <div className="h-screen w-screen flex flex-col p-6 gap-5 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 shrink-0 pt-2">
        <GhostlyLogo width={140} />
        <h1 className="text-xl font-bold text-text mt-1">
          {t("onboarding.title")}
        </h1>
        <p className="text-text/50 text-sm">{t("onboarding.tagline")}</p>
      </div>

      {/* Feature highlights */}
      <div className="max-w-[520px] w-full mx-auto flex flex-col gap-2">
        {features.map(({ Icon, text }, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-logo-primary/5 border border-logo-primary/10"
          >
            <Icon className="w-4 h-4 text-logo-primary shrink-0" />
            <span className="text-sm text-text/75">{text}</span>
          </div>
        ))}
      </div>

      {/* Model selection */}
      <div className="max-w-[520px] w-full mx-auto flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-text/40 uppercase tracking-wider whitespace-nowrap">
            {t("onboarding.modelSection")}
          </span>
          <div className="flex-1 h-px bg-mid-gray/20" />
        </div>

        {recommendedModels.map((model: ModelInfo) => (
          <div key={model.id} className="flex flex-col gap-1.5">
            <ModelCard
              model={model}
              variant="featured"
              status={getModelStatus(model.id)}
              disabled={isDownloading}
              onSelect={handleDownloadModel}
              onDownload={handleDownloadModel}
              downloadProgress={getModelDownloadProgress(model.id)}
              downloadSpeed={getModelDownloadSpeed(model.id)}
            />
            <p className="text-xs text-text/40 px-1">
              {t("onboarding.recommendedReason")}
            </p>
          </div>
        ))}

        {otherModels.length > 0 && (
          <button
            onClick={() => setShowMoreModels(!showMoreModels)}
            className="flex items-center gap-1.5 text-sm text-text/40 hover:text-text/70 transition-colors mx-auto py-1"
          >
            {showMoreModels ? (
              <>
                <ChevronUp className="w-4 h-4" />
                {t("onboarding.hideMoreModels")}
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4" />
                {t("onboarding.showMoreModels")}
              </>
            )}
          </button>
        )}

        {showMoreModels && (
          <div className="flex flex-col gap-3 pb-6">
            {otherModels.map((model: ModelInfo) => (
              <ModelCard
                key={model.id}
                model={model}
                status={getModelStatus(model.id)}
                disabled={isDownloading}
                onSelect={handleDownloadModel}
                onDownload={handleDownloadModel}
                downloadProgress={getModelDownloadProgress(model.id)}
                downloadSpeed={getModelDownloadSpeed(model.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Onboarding;
