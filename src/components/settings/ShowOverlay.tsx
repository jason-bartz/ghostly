import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import type { OverlayPosition } from "@/bindings";

interface ShowOverlayProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ShowOverlay: React.FC<ShowOverlayProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
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

    const selectedPosition = (getSetting("overlay_position") ||
      "bottom_center") as OverlayPosition;

    return (
      <SettingContainer
        title={t("settings.advanced.overlay.title")}
        description={t("settings.advanced.overlay.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <Dropdown
          options={overlayOptions}
          selectedValue={selectedPosition}
          onSelect={(value) =>
            updateSetting("overlay_position", value as OverlayPosition)
          }
          disabled={isUpdating("overlay_position")}
        />
      </SettingContainer>
    );
  },
);
