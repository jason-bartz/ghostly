import React from "react";
import { useTranslation } from "react-i18next";
import { ModelUnloadTimeoutSetting } from "../ModelUnloadTimeout";
import { FillerWords } from "../FillerWords";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { StartHidden } from "../StartHidden";
import { AutostartToggle } from "../AutostartToggle";
import { ShowTrayIcon } from "../ShowTrayIcon";
import { PasteMethodSetting } from "../PasteMethod";
import { TypingToolSetting } from "../TypingTool";
import { ClipboardHandlingSetting } from "../ClipboardHandling";
import { AutoSubmit } from "../AutoSubmit";
import { AppendTrailingSpace } from "../AppendTrailingSpace";
import { ExperimentalToggle } from "../ExperimentalToggle";
import { useSettings } from "../../../hooks/useSettings";
import { KeyboardImplementationSelector } from "../debug/KeyboardImplementationSelector";
import { AccelerationSelector } from "../AccelerationSelector";
import { LazyStreamClose } from "../LazyStreamClose";

export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const experimentalEnabled = getSetting("experimental_enabled") || false;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      {/* ── Text Output ── how transcribed text reaches apps */}
      <SettingsGroup title={t("settings.advanced.groups.output")}>
        <PasteMethodSetting descriptionMode="tooltip" grouped={true} />
        <TypingToolSetting descriptionMode="tooltip" grouped={true} />
        <ClipboardHandlingSetting descriptionMode="tooltip" grouped={true} />
        <AutoSubmit descriptionMode="tooltip" grouped={true} />
        <AppendTrailingSpace descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      {/* ── Transcription ── word corrections & model behavior */}
      <SettingsGroup title={t("settings.advanced.groups.transcription")}>
        <FillerWords descriptionMode="tooltip" grouped />
        <ModelUnloadTimeoutSetting descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      {/* ── Startup & System ── how the app launches and sits in the tray */}
      <SettingsGroup title={t("settings.advanced.groups.app")}>
        <StartHidden descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowTrayIcon descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      {/* ── Performance ── always visible; no experimental gate */}
      <SettingsGroup title={t("settings.advanced.groups.experimental")}>
        <AccelerationSelector descriptionMode="tooltip" grouped={true} />
        <LazyStreamClose descriptionMode="tooltip" grouped={true} />
        <KeyboardImplementationSelector
          descriptionMode="tooltip"
          grouped={true}
        />
        <ExperimentalToggle descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
