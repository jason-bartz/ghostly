import React from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ShortcutInput } from "../ShortcutInput";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { OutputDeviceSelector } from "../OutputDeviceSelector";
import { PushToTalk } from "../PushToTalk";
import { AudioFeedback } from "../AudioFeedback";
import { useSettings } from "../../../hooks/useSettings";
import { VolumeSlider } from "../VolumeSlider";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { ModelSettingsCard } from "./ModelSettingsCard";
import { ShowOverlay } from "../ShowOverlay";
import { SoundPicker } from "../SoundPicker";
import { ClamshellMicrophoneSelector } from "../ClamshellMicrophoneSelector";
import { AlwaysOnMicrophone } from "../AlwaysOnMicrophone";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { audioFeedbackEnabled, getSetting } = useSettings();
  const pushToTalk = getSetting("push_to_talk");
  const isLinux = type() === "linux";

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      {/* ── Shortcuts ── */}
      <SettingsGroup title={t("settings.general.shortcut.title")}>
        <ShortcutInput shortcutId="transcribe" grouped={true} />
        <PushToTalk descriptionMode="tooltip" grouped={true} />
        {/* Cancel shortcut is hidden with push-to-talk (key release cancels) and on Linux (dynamic shortcut instability) */}
        {!isLinux && !pushToTalk && (
          <ShortcutInput shortcutId="cancel" grouped={true} />
        )}
      </SettingsGroup>

      {/* ── Active model quick-switch ── */}
      <ModelSettingsCard />

      {/* ── Microphone ── */}
      <SettingsGroup title={t("settings.sound.microphone.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <ClamshellMicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <AlwaysOnMicrophone descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      {/* ── Recording feedback ── */}
      <SettingsGroup title={t("settings.sound.title")}>
        <ShowOverlay descriptionMode="tooltip" grouped={true} />
        <ShowOverlay
          descriptionMode="tooltip"
          grouped={true}
          settingKey="staged_overlay_position"
          titleKey="settings.advanced.stagedOverlay.title"
          descriptionKey="settings.advanced.stagedOverlay.description"
        />
        <AudioFeedback descriptionMode="tooltip" grouped={true} />
        <SoundPicker
          label={t("settings.sound.soundTheme.label")}
          description={t("settings.sound.soundTheme.description")}
        />
        <OutputDeviceSelector
          descriptionMode="tooltip"
          grouped={true}
          disabled={!audioFeedbackEnabled}
        />
        <VolumeSlider disabled={!audioFeedbackEnabled} />
      </SettingsGroup>
    </div>
  );
};
