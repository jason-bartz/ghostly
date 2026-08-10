import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SettingContainer } from "@/components/ui";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { useSettings } from "../../../hooks/useSettings";

const MAX_PROVIDER_ID = "ghostly_max";
const APPLE_PROVIDER_ID = "apple_intelligence";
const CUSTOM_PROVIDER_ID = "custom";

/**
 * Optional personal API key that takes over when the month's Max allowance is
 * spent.
 *
 * Collapsed by default and phrased as an escape hatch, because a Max subscriber
 * should not have to think about providers at all. Unlike the main provider
 * controls, nothing here changes which provider is *active* — the point is to
 * park a key that the backend reaches for only after the gateway answers
 * `fair_use_exceeded`.
 *
 * The backend picks the first configured non-hosted provider (see
 * `max_gateway::overflow_target`); this pane names it explicitly so the choice
 * is never a mystery. Apple Intelligence is absent for the same reason it is
 * absent there: it is not an HTTP provider and cannot be substituted at that
 * layer.
 */
export const MaxOverflowKey: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const {
    settings,
    isUpdating,
    updatePostProcessApiKey,
    updatePostProcessBaseUrl,
    updatePostProcessModel,
    fetchPostProcessModels,
    postProcessModelOptions,
  } = useSettings();

  const providers = useMemo(
    () =>
      (settings?.post_process_providers ?? []).filter(
        (p) => p.id !== MAX_PROVIDER_ID && p.id !== APPLE_PROVIDER_ID,
      ),
    [settings?.post_process_providers],
  );

  const apiKeys = settings?.post_process_api_keys ?? {};
  const models = settings?.post_process_models ?? {};

  // Mirrors `max_gateway::overflow_target`: first provider in list order that
  // has both a key and a model.
  const activeOverflow = useMemo(
    () =>
      providers.find(
        (p) =>
          (apiKeys[p.id] ?? "").trim() !== "" &&
          (models[p.id] ?? "").trim() !== "",
      ) ?? null,
    [providers, apiKeys, models],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const selectedId = editingId ?? activeOverflow?.id ?? providers[0]?.id ?? "";

  const apiKey = apiKeys[selectedId] ?? "";
  const model = models[selectedId] ?? "";

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const candidate of [
      ...(postProcessModelOptions[selectedId] ?? []),
      model,
    ]) {
      const trimmed = candidate?.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      options.push({ value: trimmed, label: trimmed });
    }
    return options;
  }, [postProcessModelOptions, selectedId, model]);

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-xl border border-hairline-strong overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-fill-2 transition-colors"
      >
        <Chevron className="h-4 w-4 shrink-0 text-mid-gray" aria-hidden />
        <span className="text-sm font-medium">{t("max.overflow.title")}</span>
        <span className="ml-auto text-xs text-mid-gray">
          {activeOverflow
            ? t("max.overflow.badgeConfigured", {
                provider: activeOverflow.label,
              })
            : t("max.overflow.badgeNone")}
        </span>
      </button>

      {open && (
        <div className="border-t border-hairline-strong">
          <p className="px-4 pt-4 text-sm text-mid-gray leading-relaxed">
            {t("max.overflow.description")}
          </p>

          <SettingContainer
            title={t("max.overflow.providerTitle")}
            description={t("max.overflow.providerDescription")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2 w-full">
              <ProviderSelect
                options={providers.map((p) => ({
                  value: p.id,
                  label: p.label,
                }))}
                value={selectedId}
                onChange={setEditingId}
              />
            </div>
          </SettingContainer>

          {selectedId === CUSTOM_PROVIDER_ID && (
            <SettingContainer
              title={t("max.overflow.baseUrlTitle")}
              description={t("max.overflow.baseUrlDescription")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              {/* Without this the custom endpoint is stuck at its Ollama
                  default, and picking "Custom" as the overflow would silently
                  post the transcript at localhost:11434. */}
              <div className="flex items-center gap-2 w-full">
                <BaseUrlField
                  value={
                    providers.find((p) => p.id === CUSTOM_PROVIDER_ID)
                      ?.base_url ?? ""
                  }
                  onBlur={(value) => {
                    const trimmed = value.trim();
                    if (trimmed) {
                      void updatePostProcessBaseUrl(
                        CUSTOM_PROVIDER_ID,
                        trimmed,
                      );
                    }
                  }}
                  disabled={isUpdating(
                    `post_process_base_url:${CUSTOM_PROVIDER_ID}`,
                  )}
                  placeholder={t(
                    "settings.postProcessing.api.baseUrl.placeholder",
                  )}
                  className="w-full max-w-[380px] min-w-0"
                  ariaLabel={t("max.overflow.baseUrlTitle")}
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("max.overflow.apiKeyTitle")}
            description={t("max.overflow.apiKeyDescription")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2 w-full">
              <ApiKeyField
                value={apiKey}
                onBlur={(value) => {
                  const trimmed = value.trim();
                  if (trimmed !== apiKey) {
                    void updatePostProcessApiKey(selectedId, trimmed);
                  }
                }}
                disabled={isUpdating(`post_process_api_key:${selectedId}`)}
                placeholder={t(
                  "settings.postProcessing.api.apiKey.placeholder",
                )}
                className="w-full max-w-[380px] min-w-0"
                ariaLabel={t("max.overflow.apiKeyTitle")}
              />
            </div>
          </SettingContainer>

          <SettingContainer
            title={t("max.overflow.modelTitle")}
            description={t("max.overflow.modelDescription")}
            descriptionMode="tooltip"
            layout="stacked"
            grouped={true}
          >
            <div className="flex items-center gap-2 w-full">
              <ModelSelect
                value={model}
                options={modelOptions}
                disabled={isUpdating(`post_process_model:${selectedId}`)}
                isLoading={isUpdating(
                  `post_process_models_fetch:${selectedId}`,
                )}
                placeholder={t(
                  "settings.postProcessing.api.model.placeholderNoOptions",
                )}
                onSelect={(value) =>
                  void updatePostProcessModel(selectedId, value.trim())
                }
                onCreate={(value) =>
                  void updatePostProcessModel(selectedId, value)
                }
                onBlur={() => {
                  if ((apiKeys[selectedId] ?? "").trim() !== "") {
                    void fetchPostProcessModels(selectedId);
                  }
                }}
                className="flex-1 min-w-0"
              />
            </div>
          </SettingContainer>
        </div>
      )}
    </div>
  );
};
