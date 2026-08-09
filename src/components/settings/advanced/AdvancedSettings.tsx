import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { PasteMethodSetting } from "../PasteMethod";
import { TypingToolSetting } from "../TypingTool";
import { ClipboardHandlingSetting } from "../ClipboardHandling";
import { AppendTrailingSpace } from "../AppendTrailingSpace";
import { PageHeader } from "../../ui/PageHeader";

/**
 * The last step of the pipeline: how finished text reaches the app you were
 * typing into.
 *
 * This pane used to be called "Output" and also carried transcription tuning,
 * startup behaviour and GPU settings — four unrelated domains under a name
 * that described one of them. Those moved to Transcription, General and
 * Performance respectively; what is left actually is text output.
 */
export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <PageHeader
        title={t("settings.pages.advanced.title")}
        description={t("settings.pages.advanced.subtitle")}
      />
      <SettingsGroup title={t("settings.advanced.groups.output")}>
        <PasteMethodSetting descriptionMode="tooltip" grouped={true} />
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
        <ClipboardHandlingSetting descriptionMode="tooltip" grouped={true} />
        <AppendTrailingSpace descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
