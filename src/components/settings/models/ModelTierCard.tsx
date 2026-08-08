import React from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Loader2, Zap } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import { formatEta, formatModelSize } from "@/lib/utils/format";
import type { ModelCardStatus } from "@/components/onboarding";

export type TierKey = "Fast" | "Balanced" | "Accurate";

interface ModelTierCardProps {
  tier: TierKey;
  model: ModelInfo;
  status: ModelCardStatus;
  /** Highlights the tier we steer new users toward. */
  recommended?: boolean;
  downloadProgress?: number;
  downloadSpeed?: number;
  onSelect: (modelId: string) => void;
  onDownload: (modelId: string) => void;
  onCancel: (modelId: string) => void;
}

/**
 * One of the three primary model choices.
 *
 * Deliberately does not show the underlying model name, engine, or the
 * accuracy/speed score bars — those are the vocabulary of the "All models"
 * list. Here the user picks an outcome ("I want this to be instant"), and the
 * card commits to exactly three facts: the promise, the language coverage, and
 * the download cost.
 */
export const ModelTierCard: React.FC<ModelTierCardProps> = ({
  tier,
  model,
  status,
  recommended = false,
  downloadProgress,
  downloadSpeed,
  onSelect,
  onDownload,
  onCancel,
}) => {
  const { t } = useTranslation();

  const isActive = status === "active";
  const isInstalled = status === "available" || status === "active";
  const isBusy =
    status === "downloading" ||
    status === "verifying" ||
    status === "extracting" ||
    status === "switching";

  const handleActivate = () => {
    if (isBusy) return;
    if (isInstalled) {
      onSelect(model.id);
    } else {
      onDownload(model.id);
    }
  };

  // The three cards form a single choice, so they are a radio group rather
  // than three independent buttons — arrow keys and screen readers both
  // depend on this.
  const shellClasses = [
    "group relative flex flex-col text-left rounded-2xl p-4 h-full",
    "transition-[transform,box-shadow,border-color,background-color] duration-200 ease-out",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
    isActive
      ? "border border-accent/55 bg-accent/[0.07] shadow-[0_0_0_1px_rgba(167,139,250,0.22),0_24px_48px_-24px_rgba(124,58,237,0.55)]"
      : "surface-card hover:border-accent/40 hover:bg-accent/[0.035] hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-20px_rgba(124,58,237,0.45)]",
    isBusy ? "cursor-progress" : "cursor-pointer",
  ].join(" ");

  return (
    <div
      role="radio"
      aria-checked={isActive}
      aria-label={t(`settings.models.tiers.${tier}.name`)}
      tabIndex={isBusy ? -1 : 0}
      onClick={handleActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleActivate();
        }
      }}
      className={shellClasses}
    >
      {/* Header: tier name + state marker. The marker slot is a fixed size so
          cards never reflow as status changes mid-download. */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h3 className="text-[15px] font-display tracking-tight text-text leading-none pt-0.5">
          {t(`settings.models.tiers.${tier}.name`)}
        </h3>
        <span className="flex items-center justify-center w-5 h-5 shrink-0">
          {isActive && (
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent/20 border border-accent/50">
              <Check className="w-3 h-3 text-accent-bright" strokeWidth={3} />
            </span>
          )}
          {isBusy && (
            <Loader2 className="w-4 h-4 text-accent-bright animate-spin" />
          )}
        </span>
      </div>

      {recommended && !isActive && (
        <span className="tag-pill self-start mb-2 !py-0.5 !text-[9.5px]">
          <Zap className="w-2.5 h-2.5" />
          {t("settings.models.tiers.recommended")}
        </span>
      )}

      <p className="text-[12.5px] leading-snug text-text-muted flex-1">
        {t(`settings.models.tiers.${tier}.promise`)}
      </p>

      {/* Footer facts. `mt-auto` pins these to the bottom so the three cards
          align on their baselines regardless of promise length. */}
      <div className="mt-3 pt-2.5 border-t border-hairline space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-text-faint">
            {t("settings.models.tiers.languages")}
          </span>
          <span className="text-text-muted tabular-nums">
            {model.supported_languages.length <= 1
              ? t("settings.models.tiers.englishOnly")
              : t("settings.models.tiers.languageCount", {
                  count: model.supported_languages.length,
                })}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-text-faint">
            {t("settings.models.tiers.size")}
          </span>
          <span className="text-text-muted tabular-nums">
            {formatModelSize(Number(model.size_mb))}
          </span>
        </div>
      </div>

      {/* Action strip. Height is reserved in every state so switching between
          "Download" and a progress bar doesn't jump the layout. */}
      <div className="mt-3 h-[26px] flex items-center">
        {status === "downloadable" && (
          <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-accent-bright">
            <Download className="w-3.5 h-3.5" />
            {t("settings.models.tiers.download")}
          </span>
        )}
        {status === "available" && (
          <span className="text-[11.5px] font-medium text-text-muted group-hover:text-accent-bright transition-colors">
            {t("settings.models.tiers.use")}
          </span>
        )}
        {isActive && (
          <span className="text-[11.5px] font-medium text-accent-bright">
            {t("settings.models.tiers.inUse")}
          </span>
        )}
        {status === "switching" && (
          <span className="text-[11.5px] text-text-muted">
            {t("modelSelector.switching")}
          </span>
        )}
        {(status === "verifying" || status === "extracting") && (
          <span className="text-[11.5px] text-text-muted">
            {t(
              status === "verifying"
                ? "modelSelector.verifyingGeneric"
                : "modelSelector.extractingGeneric",
            )}
          </span>
        )}
        {status === "downloading" && (
          <div className="w-full">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10.5px] tabular-nums text-text-muted">
                {`${Math.round(downloadProgress ?? 0)}%`}
                {downloadSpeed !== undefined && downloadSpeed > 0 && (
                  <span className="text-text-faint">
                    {" · "}
                    {formatEta(
                      Math.max(
                        0,
                        (model.size_mb * (1 - (downloadProgress ?? 0) / 100)) /
                          downloadSpeed,
                      ),
                    )}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(model.id);
                }}
                className="text-[10.5px] text-text-faint hover:text-red-400 transition-colors cursor-pointer"
              >
                {t("modelSelector.cancel")}
              </button>
            </div>
            <div className="w-full h-1 bg-fill-4 rounded-full overflow-hidden">
              <div
                className="h-full min-w-[2px] bg-gradient-to-r from-accent to-accent-deep rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${downloadProgress ?? 0}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ModelTierCard;
