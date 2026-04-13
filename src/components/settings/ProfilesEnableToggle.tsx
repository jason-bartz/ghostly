import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface Props {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ProfilesEnableToggle: React.FC<Props> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = (getSetting("profiles_enabled" as any) as boolean) ?? false;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(v) => updateSetting("profiles_enabled" as any, v as any)}
        isUpdating={isUpdating("profiles_enabled")}
        label={t("settings.profiles.enable.title")}
        description={t("settings.profiles.enable.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);

ProfilesEnableToggle.displayName = "ProfilesEnableToggle";
