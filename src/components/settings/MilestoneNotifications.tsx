import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface MilestoneNotificationsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/**
 * Opt out of the "you've dictated the length of Moby-Dick" banners.
 *
 * Turning this off only silences the notification — the sidebar card keeps
 * advancing through every milestone, and the marker in the usage blob keeps
 * moving, so switching it back on surfaces the next milestone rather than
 * replaying the ones crossed while it was off.
 */
export const MilestoneNotifications: React.FC<MilestoneNotificationsProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("milestone_notifications") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(next) => updateSetting("milestone_notifications", next)}
        isUpdating={isUpdating("milestone_notifications")}
        label={t("settings.app.milestoneNotifications.label")}
        description={t("settings.app.milestoneNotifications.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  });
