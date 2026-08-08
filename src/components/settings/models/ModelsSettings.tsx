import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Globe, Package } from "lucide-react";
import type { ModelCardStatus } from "@/components/onboarding";
import { ModelCard } from "@/components/onboarding";
import { useModelStore } from "@/stores/modelStore";
import { LANGUAGES } from "@/lib/constants/languages.ts";
import type { ModelInfo, ModelTier } from "@/bindings";
import ModelTierCard, { type TierKey } from "./ModelTierCard";

/** Display order of the primary picker. */
const TIER_ORDER: TierKey[] = ["Fast", "Balanced", "Accurate"];

/** The tier we steer new users toward. */
const RECOMMENDED_TIER: TierKey = "Balanced";

const modelSupportsLanguage = (model: ModelInfo, langCode: string): boolean =>
  model.supported_languages.includes(langCode);

export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const [languageFilter, setLanguageFilter] = useState("all");
  const [languageDropdownOpen, setLanguageDropdownOpen] = useState(false);
  const [languageSearch, setLanguageSearch] = useState("");
  const languageDropdownRef = useRef<HTMLDivElement>(null);
  const languageSearchInputRef = useRef<HTMLInputElement>(null);

  const {
    models,
    currentModel,
    downloadingModels,
    downloadProgress,
    downloadStats,
    verifyingModels,
    extractingModels,
    loading,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
  } = useModelStore();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        languageDropdownRef.current &&
        !languageDropdownRef.current.contains(event.target as Node)
      ) {
        setLanguageDropdownOpen(false);
        setLanguageSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (languageDropdownOpen && languageSearchInputRef.current) {
      languageSearchInputRef.current.focus();
    }
  }, [languageDropdownOpen]);

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) return "extracting";
    if (modelId in verifyingModels) return "verifying";
    if (modelId in downloadingModels) return "downloading";
    if (switchingModelId === modelId) return "switching";
    if (modelId === currentModel) return "active";
    const model = models.find((m: ModelInfo) => m.id === modelId);
    if (model?.is_downloaded) return "available";
    return "downloadable";
  };

  const handleModelSelect = async (modelId: string) => {
    setSwitchingModelId(modelId);
    try {
      await selectModel(modelId);
    } finally {
      setSwitchingModelId(null);
    }
  };

  const handleModelDownload = async (modelId: string) => {
    await downloadModel(modelId);
  };

  const handleModelDelete = async (modelId: string) => {
    const model = models.find((m: ModelInfo) => m.id === modelId);
    const modelName = model?.name || modelId;
    const isActive = modelId === currentModel;

    const confirmed = await ask(
      isActive
        ? t("settings.models.deleteActiveConfirm", { modelName })
        : t("settings.models.deleteConfirm", { modelName }),
      { title: t("settings.models.deleteTitle"), kind: "warning" },
    );

    if (confirmed) {
      try {
        await deleteModel(modelId);
      } catch (err) {
        console.error(`Failed to delete model ${modelId}:`, err);
      }
    }
  };

  const handleModelCancel = async (modelId: string) => {
    try {
      await cancelDownload(modelId);
    } catch (err) {
      console.error(`Failed to cancel download for ${modelId}:`, err);
    }
  };

  /** The one model carrying each tier, keyed for lookup. */
  const tierModels = useMemo(() => {
    const byTier: Partial<Record<TierKey, ModelInfo>> = {};
    for (const model of models) {
      if (model.tier) byTier[model.tier as ModelTier as TierKey] = model;
    }
    return byTier;
  }, [models]);

  /** The active model, when it isn't one of the three tiers — the bundled
   *  starter model, or something the user picked from "All models". Surfaced
   *  explicitly so the picker never looks like nothing is selected. */
  const activeNonTierModel = useMemo(() => {
    const active = models.find((m) => m.id === currentModel);
    if (!active || active.tier) return null;
    return active;
  }, [models, currentModel]);

  const filteredLanguages = useMemo(
    () =>
      LANGUAGES.filter(
        (lang) =>
          lang.value !== "auto" &&
          lang.label.toLowerCase().includes(languageSearch.toLowerCase()),
      ),
    [languageSearch],
  );

  const selectedLanguageLabel = useMemo(() => {
    if (languageFilter === "all") {
      return t("settings.models.filters.allLanguages");
    }
    return LANGUAGES.find((lang) => lang.value === languageFilter)?.label || "";
  }, [languageFilter, t]);

  /** Everything in the "All models" disclosure — tier models included, since
   *  someone opening it may want the engine detail on those too. */
  const allModelsSorted = useMemo(() => {
    const filtered = models.filter((model: ModelInfo) =>
      languageFilter === "all"
        ? true
        : modelSupportsLanguage(model, languageFilter),
    );
    return [...filtered].sort((a, b) => {
      if (a.id === currentModel) return -1;
      if (b.id === currentModel) return 1;
      // Installed before not-installed, then custom last.
      if (a.is_downloaded !== b.is_downloaded) return a.is_downloaded ? -1 : 1;
      if (a.is_custom !== b.is_custom) return a.is_custom ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [models, languageFilter, currentModel]);

  if (loading) {
    return (
      <div className="max-w-3xl w-full mx-auto">
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-logo-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold mb-1.5">
          {t("settings.models.title")}
        </h1>
        <p className="text-sm text-text-muted leading-relaxed">
          {t("settings.models.subtitle")}
        </p>
      </header>

      {/* --- Primary picker: three tiers ---------------------------------- */}
      <div
        role="radiogroup"
        aria-label={t("settings.models.title")}
        className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-stretch"
      >
        {TIER_ORDER.map((tier) => {
          const model = tierModels[tier];
          if (!model) return null;
          return (
            <ModelTierCard
              key={tier}
              tier={tier}
              model={model}
              status={getModelStatus(model.id)}
              recommended={tier === RECOMMENDED_TIER}
              downloadProgress={downloadProgress[model.id]?.percentage}
              downloadSpeed={downloadStats[model.id]?.speed}
              onSelect={handleModelSelect}
              onDownload={handleModelDownload}
              onCancel={handleModelCancel}
            />
          );
        })}
      </div>

      {/* --- Active model that isn't one of the three ---------------------- */}
      {activeNonTierModel && (
        <div className="flex items-center gap-3 rounded-xl surface-card px-4 py-3">
          <Package
            className="w-4 h-4 shrink-0 text-accent-bright"
            strokeWidth={1.75}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium truncate">
              {t("settings.models.usingOther", {
                modelName: activeNonTierModel.name,
              })}
            </p>
            <p className="text-[11.5px] text-text-muted leading-snug">
              {activeNonTierModel.is_bundled
                ? t("settings.models.bundledNote")
                : t("settings.models.otherNote")}
            </p>
          </div>
        </div>
      )}

      {/* --- All models (disclosure) --------------------------------------- */}
      <div>
        <button
          type="button"
          onClick={() => setShowAllModels((v) => !v)}
          aria-expanded={showAllModels}
          className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-muted hover:text-text transition-colors cursor-pointer"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform duration-200 ${
              showAllModels ? "rotate-180" : ""
            }`}
          />
          {t("settings.models.allModels", { count: models.length })}
        </button>

        {showAllModels && (
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-text-muted max-w-md leading-snug">
                {t("settings.models.allModelsHint")}
              </p>

              <div className="relative shrink-0" ref={languageDropdownRef}>
                <button
                  type="button"
                  onClick={() => setLanguageDropdownOpen(!languageDropdownOpen)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors cursor-pointer ${
                    languageFilter !== "all"
                      ? "bg-accent/15 text-accent-bright border border-accent/35"
                      : "bg-fill-1 text-text-muted border border-hairline hover:bg-fill-3 hover:text-text"
                  }`}
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span className="max-w-[120px] truncate">
                    {selectedLanguageLabel}
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 transition-transform ${
                      languageDropdownOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {languageDropdownOpen && (
                  <div className="absolute top-full end-0 mt-1.5 w-56 glass-raised rounded-xl z-50 overflow-hidden">
                    <div className="p-2 border-b border-hairline">
                      <input
                        ref={languageSearchInputRef}
                        type="text"
                        value={languageSearch}
                        onChange={(e) => setLanguageSearch(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            filteredLanguages.length > 0
                          ) {
                            setLanguageFilter(filteredLanguages[0].value);
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          } else if (e.key === "Escape") {
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          }
                        }}
                        placeholder={t(
                          "settings.general.language.searchPlaceholder",
                        )}
                        className="w-full px-2.5 py-1.5 text-[12.5px] bg-fill-2 border border-hairline rounded-lg focus:outline-none focus:ring-1 focus:ring-accent/50 placeholder:text-text-faint"
                      />
                    </div>
                    <div className="max-h-48 overflow-y-auto py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setLanguageFilter("all");
                          setLanguageDropdownOpen(false);
                          setLanguageSearch("");
                        }}
                        className={`w-full px-3 py-1.5 text-[12.5px] text-start transition-colors cursor-pointer ${
                          languageFilter === "all"
                            ? "text-accent-bright font-medium"
                            : "text-text-muted hover:bg-fill-2 hover:text-text"
                        }`}
                      >
                        {t("settings.models.filters.allLanguages")}
                      </button>
                      {filteredLanguages.map((lang) => (
                        <button
                          key={lang.value}
                          type="button"
                          onClick={() => {
                            setLanguageFilter(lang.value);
                            setLanguageDropdownOpen(false);
                            setLanguageSearch("");
                          }}
                          className={`w-full px-3 py-1.5 text-[12.5px] text-start transition-colors cursor-pointer ${
                            languageFilter === lang.value
                              ? "text-accent-bright font-medium"
                              : "text-text-muted hover:bg-fill-2 hover:text-text"
                          }`}
                        >
                          {lang.label}
                        </button>
                      ))}
                      {filteredLanguages.length === 0 && (
                        <div className="px-3 py-2 text-[12.5px] text-text-faint text-center">
                          {t("settings.general.language.noResults")}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {allModelsSorted.length > 0 ? (
              allModelsSorted.map((model: ModelInfo) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  status={getModelStatus(model.id)}
                  onSelect={handleModelSelect}
                  onDownload={handleModelDownload}
                  // Bundled models ship inside the app and reinstall on
                  // launch, so offering a delete button would be a lie.
                  onDelete={model.is_bundled ? undefined : handleModelDelete}
                  onCancel={handleModelCancel}
                  downloadProgress={downloadProgress[model.id]?.percentage}
                  downloadSpeed={downloadStats[model.id]?.speed}
                  showRecommended={false}
                />
              ))
            ) : (
              <div className="text-center py-8 text-text-faint text-sm">
                {t("settings.models.noModelsMatch")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
