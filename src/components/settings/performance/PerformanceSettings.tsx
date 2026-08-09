import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { AccelerationSelector } from "../AccelerationSelector";
import { LazyStreamClose } from "../LazyStreamClose";
import { KeyboardImplementationSelector } from "../debug/KeyboardImplementationSelector";
import { PageHeader } from "../../ui/PageHeader";

/**
 * Knobs that trade safety for speed.
 *
 * Lives behind the Advanced disclosure: these change how transcription runs at
 * a level most people should never need to touch, and a wrong answer here
 * looks like a bug rather than a preference.
 *
 * The "Experimental Features" group used to live here and gated exactly one
 * thing — Open Mic. Open Mic now ships under Dictation, so the group gated
 * nothing, and a switch that changes nothing visible is worse than no switch.
 * `experimental_enabled` is left in settings and in the diagnostics bundle so
 * the next incubating feature can pick it back up.
 */
export const PerformanceSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <PageHeader
        title={t("settings.pages.performance.title")}
        description={t("settings.pages.performance.subtitle")}
      />
      <SettingsGroup title={t("settings.performance.groups.speed")}>
        <AccelerationSelector descriptionMode="tooltip" grouped={true} />
        <LazyStreamClose descriptionMode="tooltip" grouped={true} />
        <KeyboardImplementationSelector
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>
    </div>
  );
};
