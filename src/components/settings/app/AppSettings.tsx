import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { AppearanceSelector } from "../AppearanceSelector";
import { StartHidden } from "../StartHidden";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { ShowDockIcon } from "../ShowDockIcon";
import { ReplayTour } from "../ReplayTour";
import { PageHeader } from "../../ui/PageHeader";

/**
 * How the app itself looks and behaves — as opposed to what it does with your
 * voice.
 *
 * Appearance used to live under Recording, which put "what colour is the app"
 * next to "which microphone". Everything a person thinks of as an app-level
 * preference now sits together in one predictable place.
 */
export const AppSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <PageHeader
        title={t("settings.pages.app.title")}
        description={t("settings.pages.app.subtitle")}
      />
      <SettingsGroup title={t("settings.appearance.group")}>
        <AppearanceSelector />
      </SettingsGroup>

      <SettingsGroup title={t("settings.app.groups.startup")}>
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <StartHidden descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.app.groups.menusAndDock")}>
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
        <ShowDockIcon descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.app.groups.help")}>
        <ReplayTour grouped={true} />
      </SettingsGroup>
    </div>
  );
};
