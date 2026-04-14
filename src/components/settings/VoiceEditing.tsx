import React from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettings } from "../../hooks/useSettings";
import { Dropdown, SettingContainer, Slider, ToggleSwitch } from "../ui";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { ShortcutInput } from "./ShortcutInput";

type ReplaceStrategy = "select_and_paste" | "repaste_only" | "off";

export const VoiceEditing: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const enabled = (getSetting("voice_editing_enabled") as boolean) ?? false;
  const prefixDetection =
    (getSetting("voice_edit_prefix_detection") as boolean) ?? false;
  const strategy =
    (getSetting("voice_edit_replace_strategy") as
      | ReplaceStrategy
      | undefined) ?? "select_and_paste";
  const bufferSize = (getSetting("session_buffer_size") as number) ?? 10;
  const idleTimeout =
    (getSetting("session_idle_timeout_secs") as number) ?? 120;

  const handleClearSession = async () => {
    const res = await commands.clearVoiceEditSession();
    if (res.status === "ok") {
      toast.success(t("settings.voiceEditing.sessionCleared"));
    } else {
      toast.error(res.error);
    }
  };

  return (
    <>
      <ToggleSwitch
        label={t("settings.voiceEditing.enable.title")}
        description={t("settings.voiceEditing.enable.description")}
        checked={enabled}
        onChange={(v) =>
          updateSetting("voice_editing_enabled" as any, v as any)
        }
        isUpdating={isUpdating("voice_editing_enabled")}
        grouped={true}
      />

      {enabled && (
        <>
          <Alert variant="warning" contained>
            {t("settings.voiceEditing.experimental")}
          </Alert>

          <ShortcutInput
            shortcutId="edit_last_transcription"
            descriptionMode="tooltip"
            grouped={true}
          />

          <ToggleSwitch
            label={t("settings.voiceEditing.prefixDetection.title")}
            description={t("settings.voiceEditing.prefixDetection.description")}
            checked={prefixDetection}
            onChange={(v) =>
              updateSetting("voice_edit_prefix_detection" as any, v as any)
            }
            isUpdating={isUpdating("voice_edit_prefix_detection")}
            grouped={true}
          />

          <SettingContainer
            title={t("settings.voiceEditing.replaceStrategy.title")}
            description={t("settings.voiceEditing.replaceStrategy.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <Dropdown
              options={[
                {
                  value: "select_and_paste",
                  label: t(
                    "settings.voiceEditing.replaceStrategy.selectAndPaste",
                  ),
                },
                {
                  value: "repaste_only",
                  label: t("settings.voiceEditing.replaceStrategy.repasteOnly"),
                },
                {
                  value: "off",
                  label: t("settings.voiceEditing.replaceStrategy.off"),
                },
              ]}
              selectedValue={strategy}
              onSelect={(v) =>
                updateSetting("voice_edit_replace_strategy" as any, v as any)
              }
            />
          </SettingContainer>

          <Slider
            label={t("settings.voiceEditing.bufferSize.title")}
            description={t("settings.voiceEditing.bufferSize.description")}
            value={bufferSize}
            min={1}
            max={20}
            step={1}
            onChange={(v) =>
              updateSetting("session_buffer_size" as any, v as any)
            }
            formatValue={(v) => `${v}`}
            grouped={true}
          />

          <Slider
            label={t("settings.voiceEditing.idleTimeout.title")}
            description={t("settings.voiceEditing.idleTimeout.description")}
            value={idleTimeout}
            min={10}
            max={600}
            step={10}
            onChange={(v) =>
              updateSetting("session_idle_timeout_secs" as any, v as any)
            }
            formatValue={(v) => `${v}s`}
            grouped={true}
          />

          <div className="px-4 py-2">
            <Button variant="secondary" size="sm" onClick={handleClearSession}>
              {t("settings.voiceEditing.clearSession")}
            </Button>
          </div>
        </>
      )}
    </>
  );
});

VoiceEditing.displayName = "VoiceEditing";
