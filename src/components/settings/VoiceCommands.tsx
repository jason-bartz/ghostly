import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { SettingContainer } from "../ui/SettingContainer";
import { ShortcutInput } from "./ShortcutInput";
import type { VoiceCommand } from "@/bindings";

interface VoiceCommandsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const VoiceCommands: React.FC<VoiceCommandsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("voice_commands_enabled") ?? false;
    const commands: VoiceCommand[] = getSetting("voice_commands") ?? [];
    const updating = isUpdating("voice_commands");

    const [draftName, setDraftName] = useState("");
    const [draftPhrases, setDraftPhrases] = useState("");
    const [draftKeystroke, setDraftKeystroke] = useState("");

    const handleToggle = (next: boolean) => {
      updateSetting("voice_commands_enabled", next);
    };

    const handleToggleCommand = (index: number, next: boolean) => {
      const updated = commands.map((c, i) =>
        i === index ? { ...c, enabled: next } : c,
      );
      updateSetting("voice_commands", updated);
    };

    const handleRemove = (index: number) => {
      updateSetting(
        "voice_commands",
        commands.filter((_, i) => i !== index),
      );
    };

    const handleAdd = () => {
      const name = draftName.trim();
      const phrases = draftPhrases
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const keystroke = draftKeystroke.trim();
      if (!name || phrases.length === 0 || !keystroke) {
        toast.error(t("settings.voiceCommands.missingFields"));
        return;
      }
      const next: VoiceCommand = { name, phrases, keystroke, enabled: true };
      updateSetting("voice_commands", [...commands, next]);
      setDraftName("");
      setDraftPhrases("");
      setDraftKeystroke("");
    };

    return (
      <>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          label={t("settings.voiceCommands.enable.title")}
          description={t("settings.voiceCommands.enable.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        />

        {enabled && (
          <>
            <ShortcutInput
              shortcutId="voice_command"
              descriptionMode={descriptionMode}
              grouped={grouped}
            />

            <SettingContainer
              title={t("settings.voiceCommands.list.title")}
              description={t("settings.voiceCommands.list.description")}
              descriptionMode={descriptionMode}
              grouped={grouped}
              layout="stacked"
            >
              <div className="space-y-2">
                {commands.length === 0 && (
                  <p className="text-sm text-mid-gray/70">
                    {t("settings.voiceCommands.empty")}
                  </p>
                )}
                {commands.map((cmd, i) => (
                  <div
                    key={`${cmd.name}-${i}`}
                    className="flex items-center gap-3 p-2 rounded-md border border-mid-gray/20"
                  >
                    <input
                      type="checkbox"
                      checked={cmd.enabled}
                      onChange={(e) => handleToggleCommand(i, e.target.checked)}
                      disabled={updating}
                      className="h-4 w-4"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm">{cmd.name}</div>
                      <div className="text-xs text-mid-gray/70 truncate">
                        {cmd.phrases.join(", ")} → {cmd.keystroke}
                      </div>
                    </div>
                    <Button
                      onClick={() => handleRemove(i)}
                      variant="secondary"
                      size="sm"
                      disabled={updating}
                    >
                      {t("settings.voiceCommands.remove")}
                    </Button>
                  </div>
                ))}
              </div>
            </SettingContainer>

            <SettingContainer
              title={t("settings.voiceCommands.add.title")}
              description={t("settings.voiceCommands.add.description")}
              descriptionMode={descriptionMode}
              grouped={grouped}
              layout="stacked"
            >
              <div className="space-y-2">
                <Input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder={t("settings.voiceCommands.add.namePlaceholder")}
                  variant="compact"
                  disabled={updating}
                />
                <Input
                  type="text"
                  value={draftPhrases}
                  onChange={(e) => setDraftPhrases(e.target.value)}
                  placeholder={t(
                    "settings.voiceCommands.add.phrasesPlaceholder",
                  )}
                  variant="compact"
                  disabled={updating}
                />
                <Input
                  type="text"
                  value={draftKeystroke}
                  onChange={(e) => setDraftKeystroke(e.target.value)}
                  placeholder={t(
                    "settings.voiceCommands.add.keystrokePlaceholder",
                  )}
                  variant="compact"
                  disabled={updating}
                />
                <Button
                  onClick={handleAdd}
                  variant="primary"
                  size="md"
                  disabled={
                    updating ||
                    !draftName.trim() ||
                    !draftPhrases.trim() ||
                    !draftKeystroke.trim()
                  }
                >
                  {t("settings.voiceCommands.add.button")}
                </Button>
              </div>
            </SettingContainer>
          </>
        )}
      </>
    );
  },
);
