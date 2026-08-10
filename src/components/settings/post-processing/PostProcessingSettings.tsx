import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, RefreshCcw } from "lucide-react";
import { toast } from "sonner";
import { commands } from "@/bindings";

import { Alert } from "../../ui/Alert";
import {
  Dropdown,
  SettingContainer,
  SettingsGroup,
  Textarea,
  ToggleSwitch,
} from "@/components/ui";
import { Button } from "../../ui/Button";
import { showMaxUpgrade } from "@/lib/maxUpgrade";
import { ResetButton } from "../../ui/ResetButton";
import { Input } from "../../ui/Input";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { ShortcutInput } from "../ShortcutInput";
import { VoiceEditing } from "../VoiceEditing";
import { useSettings } from "../../../hooks/useSettings";
import { MaxProviderPanel } from "../max/MaxProviderPanel";
import { MaxOverflowKey } from "../max/MaxOverflowKey";
import { isMaxLicense, useMaxStore } from "@/stores/maxStore";

const PostProcessingSettingsApiComponent: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.api.provider.title")}
        description={t("settings.postProcessing.api.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ProviderSelect
            options={state.providerOptions}
            value={state.selectedProviderId}
            onChange={state.handleProviderSelect}
          />
        </div>
      </SettingContainer>

      {state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.postProcessing.api.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.postProcessing.api.baseUrl.title")}
              description={t("settings.postProcessing.api.baseUrl.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <div className="flex items-center gap-2 w-full">
                <BaseUrlField
                  value={state.baseUrl}
                  onBlur={state.handleBaseUrlChange}
                  placeholder={t(
                    "settings.postProcessing.api.baseUrl.placeholder",
                  )}
                  disabled={state.isBaseUrlUpdating}
                  className="w-full max-w-[380px] min-w-0"
                  ariaLabel={t("settings.postProcessing.api.baseUrl.title")}
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.apiKey.title")}
            description={t("settings.postProcessing.api.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2 w-full">
              <ApiKeyField
                value={state.apiKey}
                onBlur={state.handleApiKeyChange}
                placeholder={t(
                  "settings.postProcessing.api.apiKey.placeholder",
                )}
                disabled={state.isApiKeyUpdating}
                className="w-full max-w-[380px] min-w-0"
                ariaLabel={t("settings.postProcessing.api.apiKey.title")}
              />
            </div>
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && (
        <SettingContainer
          title={t("settings.postProcessing.api.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.postProcessing.api.model.descriptionCustom")
              : t("settings.postProcessing.api.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="flex items-center gap-2 w-full">
            <ModelSelect
              value={state.model}
              options={state.modelOptions}
              disabled={state.isModelUpdating}
              isLoading={state.isFetchingModels}
              placeholder={
                state.modelOptions.length > 0
                  ? t(
                      "settings.postProcessing.api.model.placeholderWithOptions",
                    )
                  : t("settings.postProcessing.api.model.placeholderNoOptions")
              }
              onSelect={state.handleModelSelect}
              onCreate={state.handleModelCreate}
              onBlur={() => {}}
              className="flex-1 min-w-0"
            />
            <ResetButton
              onClick={state.handleRefreshModels}
              disabled={state.isFetchingModels}
              ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
              className="flex h-10 w-10 items-center justify-center"
            >
              <RefreshCcw
                className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
              />
            </ResetButton>
          </div>
        </SettingContainer>
      )}

      <TestConnectionRow />
    </>
  );
};

const TestConnectionRow: React.FC = () => {
  const { t } = useTranslation();
  const [isTesting, setIsTesting] = useState(false);

  const handleTest = async () => {
    setIsTesting(true);
    try {
      const result = await commands.testPostProcessConnection();
      if (result.status === "ok") {
        toast.success(t("settings.postProcessing.api.testConnection.success"));
      } else {
        toast.error(t("settings.postProcessing.api.testConnection.failed"), {
          description: result.error,
        });
      }
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <SettingContainer
      title={t("settings.postProcessing.api.testConnection.title")}
      description={t("settings.postProcessing.api.testConnection.description")}
      descriptionMode="tooltip"
      layout="horizontal"
      grouped={true}
    >
      <Button
        onClick={handleTest}
        disabled={isTesting}
        variant="secondary"
        size="md"
      >
        {isTesting
          ? t("settings.postProcessing.api.testConnection.testing")
          : t("settings.postProcessing.api.testConnection.button")}
      </Button>
    </SettingContainer>
  );
};

const PostProcessingSettingsPromptsComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  useEffect(() => {
    if (isCreating) return;

    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  }, [
    isCreating,
    selectedPromptId,
    selectedPrompt?.name,
    selectedPrompt?.prompt,
  ]);

  const handlePromptSelect = (promptId: string | null) => {
    if (!promptId) return;
    updateSetting("post_process_selected_prompt_id", promptId);
    setIsCreating(false);
  };

  const handleCreatePrompt = async () => {
    if (!draftName.trim() || !draftText.trim()) return;

    try {
      const result = await commands.addPostProcessPrompt(
        draftName.trim(),
        draftText.trim(),
      );
      if (result.status === "ok") {
        await refreshSettings();
        updateSetting("post_process_selected_prompt_id", result.data.id);
        setIsCreating(false);
      }
    } catch (error) {
      console.error("Failed to create prompt:", error);
    }
  };

  const handleUpdatePrompt = async () => {
    if (!selectedPromptId || !draftName.trim() || !draftText.trim()) return;

    try {
      await commands.updatePostProcessPrompt(
        selectedPromptId,
        draftName.trim(),
        draftText.trim(),
      );
      await refreshSettings();
    } catch (error) {
      console.error("Failed to update prompt:", error);
    }
  };

  const handleDeletePrompt = async (promptId: string) => {
    if (!promptId) return;

    try {
      await commands.deletePostProcessPrompt(promptId);
      await refreshSettings();
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to delete prompt:", error);
    }
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  };

  const handleStartCreate = () => {
    setIsCreating(true);
    setDraftName("");
    setDraftText("");
  };

  const hasPrompts = prompts.length > 0;
  const isDirty =
    !!selectedPrompt &&
    (draftName.trim() !== selectedPrompt.name ||
      draftText.trim() !== selectedPrompt.prompt.trim());

  return (
    <SettingContainer
      title={t("settings.postProcessing.prompts.selectedPrompt.title")}
      description={t(
        "settings.postProcessing.prompts.selectedPrompt.description",
      )}
      descriptionMode="tooltip"
      layout="stacked"
      grouped={true}
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <Dropdown
            selectedValue={selectedPromptId || null}
            options={prompts.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onSelect={(value) => handlePromptSelect(value)}
            placeholder={
              prompts.length === 0
                ? t("settings.postProcessing.prompts.noPrompts")
                : t("settings.postProcessing.prompts.selectPrompt")
            }
            disabled={
              isUpdating("post_process_selected_prompt_id") || isCreating
            }
            className="flex-1"
          />
          <Button
            onClick={handleStartCreate}
            variant="primary"
            size="md"
            disabled={isCreating}
          >
            {t("settings.postProcessing.prompts.createNew")}
          </Button>
        </div>

        {!isCreating && hasPrompts && selectedPrompt && (
          <div className="space-y-3">
            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p className="text-xs text-mid-gray/70">
                <Trans
                  i18nKey="settings.postProcessing.prompts.promptTip"
                  components={{ code: <code /> }}
                />
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleUpdatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim() || !isDirty}
              >
                {t("settings.postProcessing.prompts.updatePrompt")}
              </Button>
              <Button
                onClick={() => handleDeletePrompt(selectedPromptId)}
                variant="secondary"
                size="md"
                disabled={!selectedPromptId || prompts.length <= 1}
              >
                {t("settings.postProcessing.prompts.deletePrompt")}
              </Button>
            </div>
          </div>
        )}

        {!isCreating && !selectedPrompt && (
          <div className="p-3 bg-fill-2 rounded-md border border-hairline-strong">
            <p className="text-sm text-mid-gray">
              {hasPrompts
                ? t("settings.postProcessing.prompts.selectToEdit")
                : t("settings.postProcessing.prompts.createFirst")}
            </p>
          </div>
        )}

        {isCreating && (
          <div className="space-y-3">
            <div className="space-y-2 block flex flex-col">
              <label className="text-sm font-semibold text-text">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p className="text-xs text-mid-gray/70">
                <Trans
                  i18nKey="settings.postProcessing.prompts.promptTip"
                  components={{ code: <code /> }}
                />
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleCreatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim()}
              >
                {t("settings.postProcessing.prompts.createPrompt")}
              </Button>
              <Button
                onClick={handleCancelCreate}
                variant="secondary"
                size="md"
              >
                {t("settings.postProcessing.prompts.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingContainer>
  );
};

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

export const PostProcessingSettingsPrompts = React.memo(
  PostProcessingSettingsPromptsComponent,
);
PostProcessingSettingsPrompts.displayName = "PostProcessingSettingsPrompts";

const APPLE_INTELLIGENCE_PROVIDER_ID = "apple_intelligence";

const ConnectionStatusCard: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();

  const providerId = (getSetting("post_process_provider_id") as string) || "";
  const providers =
    (getSetting("post_process_providers") as
      | { id: string; label: string }[]
      | undefined) ?? [];
  const models =
    (getSetting("post_process_models") as Record<string, string> | undefined) ??
    {};
  const apiKeys =
    (getSetting("post_process_api_keys") as
      | Record<string, string>
      | undefined) ?? {};

  const provider = providers.find((p) => p.id === providerId);
  const model = (models[providerId] ?? "").trim();
  const apiKey = (apiKeys[providerId] ?? "").trim();
  const isApple = providerId === APPLE_INTELLIGENCE_PROVIDER_ID;

  let status: "connected" | "needs-key" | "needs-model";
  if (isApple) {
    status = model ? "connected" : "needs-model";
  } else if (!apiKey) {
    status = "needs-key";
  } else if (!model) {
    status = "needs-model";
  } else {
    status = "connected";
  }

  const connected = status === "connected";
  const Icon = connected ? CheckCircle2 : AlertCircle;
  const iconColor = connected ? "text-success" : "text-warning";
  const label = provider?.label ?? providerId;

  const message = connected
    ? isApple
      ? t("settings.postProcessing.connection.appleIntelligence")
      : t("settings.postProcessing.connection.connected", { provider: label })
    : status === "needs-key"
      ? t("settings.postProcessing.connection.needsKey")
      : t("settings.postProcessing.connection.needsModel");

  // The one honest place to mention Max. This card only appears because the
  // user has turned refinement on and has no way to run it — they have already
  // said they want the feature. Anywhere else would be advertising; here it is
  // the answer to the question on screen.
  //
  // Nothing is gated: the API-key field is right below, and it stays.
  const showMaxHint = status === "needs-key";

  return (
    <div className="rounded-lg border border-hairline-strong bg-fill-2">
      <div className="flex items-center gap-3 px-4 py-3" role="status">
        <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} aria-hidden="true" />
        <span className="text-sm">{message}</span>
      </div>
      {showMaxHint && (
        <div className="flex items-center justify-between gap-4 border-t border-hairline px-4 py-3">
          <p className="text-sm text-mid-gray">{t("max.upsell.noKeyHint")}</p>
          <Button variant="secondary" size="sm" onClick={showMaxUpgrade}>
            {t("max.upsell.learnMore")}
          </Button>
        </div>
      )}
    </div>
  );
};

const RefinementEnabledToggle: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const enabled = getSetting("refinement_enabled") ?? true;

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) => updateSetting("refinement_enabled", value)}
      isUpdating={isUpdating("refinement_enabled")}
      label={t("settings.postProcessing.enable.label")}
      description={t("settings.postProcessing.enable.description")}
      descriptionMode="inline"
      grouped={true}
    />
  );
};

const DeterministicCleanupToggle: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const enabled = getSetting("deterministic_cleanup_in_ai_apps") ?? true;

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) =>
        updateSetting("deterministic_cleanup_in_ai_apps", value)
      }
      isUpdating={isUpdating("deterministic_cleanup_in_ai_apps")}
      label={t("settings.postProcessing.aiAppBypass.label")}
      description={t("settings.postProcessing.aiAppBypass.description")}
      descriptionMode="inline"
      grouped={true}
    />
  );
};

const MAX_PROVIDER_ID = "ghostly_max";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, setPostProcessProvider } = useSettings();
  const refinementEnabled = getSetting("refinement_enabled") ?? true;

  // Max replaces the whole provider/model/key block. Gated on the offline
  // token rather than a `/ai/status` round-trip so the pane never flashes the
  // configuration UI at a subscriber while a request is in flight.
  const license = useMaxStore((s) => s.license);
  const aiStatus = useMaxStore((s) => s.aiStatus);
  const refresh = useMaxStore((s) => s.refresh);
  const isMax = isMaxLicense(license);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const goToAccount = () => {
    window.dispatchEvent(new Event("ghostly-navigate-to-license"));
  };

  const activeProviderId = (getSetting("post_process_provider_id") ??
    "") as string;
  const activeProviderLabel =
    isMax && activeProviderId !== MAX_PROVIDER_ID
      ? ((getSetting("post_process_providers") ?? []).find(
          (p) => p.id === activeProviderId,
        )?.label ?? activeProviderId)
      : null;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.postProcessing.title")}>
        <RefinementEnabledToggle />
        {refinementEnabled && <DeterministicCleanupToggle />}
      </SettingsGroup>

      {refinementEnabled && isMax && (
        <>
          <MaxProviderPanel
            status={aiStatus}
            onOpenAccount={goToAccount}
            activeProviderLabel={activeProviderLabel}
            onUseMax={() => void setPostProcessProvider(MAX_PROVIDER_ID)}
          />
          <MaxOverflowKey />
        </>
      )}

      {refinementEnabled && (
        <>
          {!isMax && <ConnectionStatusCard />}

          {!isMax && (
            <SettingsGroup title={t("settings.postProcessing.api.title")}>
              <PostProcessingSettingsApi />
            </SettingsGroup>
          )}

          <SettingsGroup title={t("settings.postProcessing.prompts.title")}>
            <PostProcessingSettingsPrompts />
          </SettingsGroup>

          <SettingsGroup title={t("settings.postProcessing.hotkey.title")}>
            <ShortcutInput
              shortcutId="transcribe_verbatim"
              descriptionMode="tooltip"
              grouped={true}
            />
            <ShortcutInput
              shortcutId="transcribe_with_screenshot"
              descriptionMode="tooltip"
              grouped={true}
            />
          </SettingsGroup>

          <SettingsGroup title={t("settings.voiceEditing.title")}>
            <VoiceEditing />
          </SettingsGroup>
        </>
      )}
    </div>
  );
};
