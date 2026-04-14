import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { IdePresets } from "../IdePresets";
import { VoiceCommands } from "../VoiceCommands";
import { RestApiSettings } from "../RestApiSettings";

export const DeveloperSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="text-sm text-mid-gray/70 leading-relaxed">
        {t("settings.developer.intro")}
      </div>

      <SettingsGroup title={t("settings.idePresets.title")}>
        <IdePresets descriptionMode="tooltip" grouped />
      </SettingsGroup>

      <SettingsGroup title={t("settings.voiceCommands.title")}>
        <VoiceCommands descriptionMode="tooltip" grouped />
      </SettingsGroup>

      <RestApiSettings />
    </div>
  );
};
