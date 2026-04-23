import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import type { OverlayPosition } from "@/bindings";

type OverlaySettingKey = "overlay_position" | "staged_overlay_position";

interface ShowOverlayProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  settingKey?: OverlaySettingKey;
  titleKey?: string;
  descriptionKey?: string;
}

export const ShowOverlay: React.FC<ShowOverlayProps> = React.memo(
  ({
    descriptionMode = "tooltip",
    grouped = false,
    settingKey = "overlay_position",
    titleKey = "settings.advanced.overlay.title",
    descriptionKey = "settings.advanced.overlay.description",
  }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const overlayOptions = [
      { value: "none", label: t("settings.advanced.overlay.options.none") },
      {
        value: "top_left",
        label: t("settings.advanced.overlay.options.top_left"),
      },
      {
        value: "top_center",
        label: t("settings.advanced.overlay.options.top_center"),
      },
      {
        value: "top_right",
        label: t("settings.advanced.overlay.options.top_right"),
      },
      {
        value: "bottom_left",
        label: t("settings.advanced.overlay.options.bottom_left"),
      },
      {
        value: "bottom_center",
        label: t("settings.advanced.overlay.options.bottom_center"),
      },
      {
        value: "bottom_right",
        label: t("settings.advanced.overlay.options.bottom_right"),
      },
    ];

    const selectedPosition = (getSetting(settingKey) ||
      "bottom_center") as OverlayPosition;

    return (
      <SettingContainer
        title={t(titleKey)}
        description={t(descriptionKey)}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <Dropdown
          options={overlayOptions}
          selectedValue={selectedPosition}
          onSelect={(value) =>
            updateSetting(settingKey, value as OverlayPosition)
          }
          disabled={isUpdating(settingKey)}
        />
      </SettingContainer>
    );
  },
);
