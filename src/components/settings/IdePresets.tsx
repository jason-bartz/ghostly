import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands, type IdePreset } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";

function formatKeystroke(ks: string): string {
  return ks
    .split("+")
    .map((t) => {
      const s = t.trim().toLowerCase();
      if (s === "enter" || s === "return") return "↵";
      if (s === "escape" || s === "esc") return "⎋";
      if (s === "tab") return "⇥";
      if (s === "shift") return "⇧";
      if (s === "cmd" || s === "meta") return "⌘";
      if (s === "ctrl" || s === "control") return "⌃";
      if (s === "alt" || s === "option") return "⌥";
      return t;
    })
    .join("");
}

interface IdePresetsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const IdePresets: React.FC<IdePresetsProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const [presets, setPresets] = useState<IdePreset[]>([]);
  const [detectedId, setDetectedId] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const enabled = getSetting("ide_presets_enabled") ?? true;
  const autoSubmit = getSetting("ide_auto_submit") ?? true;
  const seen = getSetting("seen_ide_hints") ?? [];

  useEffect(() => {
    commands
      .getIdePresets()
      .then((list) => setPresets(list))
      .catch(() => {
        // Non-fatal: the section will just render empty.
      });
  }, []);

  const handleToggleEnabled = async (value: boolean) => {
    const result = await commands.setIdePresetsEnabled(value);
    if (result.status === "ok") {
      updateSetting("ide_presets_enabled", value);
    } else {
      toast.error(String(result.error));
    }
  };

  const handleToggleAutoSubmit = async (value: boolean) => {
    const result = await commands.setIdeAutoSubmit(value);
    if (result.status === "ok") {
      updateSetting("ide_auto_submit", value);
    } else {
      toast.error(String(result.error));
    }
  };

  const handleResetHints = async () => {
    const result = await commands.resetSeenIdeHints();
    if (result.status === "ok") {
      updateSetting("seen_ide_hints", []);
      toast.success(t("settings.idePresets.hintsReset"));
    } else {
      toast.error(String(result.error));
    }
  };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const ctx = await commands.detectFrontmostApp();
      if (ctx.status !== "ok" || !ctx.data) {
        setDetectedId(null);
        toast.error(t("settings.idePresets.detectFailed"));
        return;
      }
      const bundle = (ctx.data.bundleId ?? "").toLowerCase();
      const title = (ctx.data.windowTitle ?? "").toLowerCase();
      const exe = (ctx.data.exePath ?? "").toLowerCase();
      // Mirror the Rust detection heuristics. Kept in sync manually — if
      // ide_presets.rs changes, update this too.
      const match = presets.find((p) => {
        if (p.id === "cursor")
          return (
            bundle.includes("cursor") ||
            bundle.includes("todesktop.230313mzl4w4u92") ||
            exe.includes("/cursor.app/")
          );
        if (p.id === "windsurf")
          return bundle.includes("windsurf") || bundle.includes("exafunction");
        if (p.id === "replit")
          return bundle.includes("replit") || title.includes("replit");
        if (p.id === "vscode")
          return (
            bundle.includes("com.microsoft.vscode") ||
            bundle.includes("visualstudio.code") ||
            bundle.includes("vscodium")
          );
        if (p.id === "claude_code") {
          const term =
            bundle.includes("apple.terminal") ||
            bundle.includes("iterm") ||
            bundle.includes("alacritty") ||
            bundle.includes("warp") ||
            bundle.includes("ghostty") ||
            bundle.includes("kitty") ||
            bundle.includes("wezterm") ||
            bundle.includes("hyper");
          return term && title.includes("claude");
        }
        return false;
      });
      setDetectedId(match?.id ?? "__none__");
    } finally {
      setDetecting(false);
    }
  };

  return (
    <>
      <ToggleSwitch
        checked={enabled}
        onChange={handleToggleEnabled}
        label={t("settings.idePresets.enable.title")}
        description={t("settings.idePresets.enable.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />

      {enabled && (
        <>
          <ToggleSwitch
            checked={autoSubmit}
            onChange={handleToggleAutoSubmit}
            label={t("settings.idePresets.autoSubmit.title")}
            description={t("settings.idePresets.autoSubmit.description")}
            descriptionMode={descriptionMode}
            grouped={grouped}
          />

          <SettingContainer
            title={t("settings.idePresets.detect.title")}
            description={t("settings.idePresets.detect.description")}
            descriptionMode={descriptionMode}
            grouped={grouped}
            layout="stacked"
          >
            <div className="flex items-center gap-3">
              <Button
                onClick={handleDetect}
                variant="secondary"
                size="sm"
                disabled={detecting}
              >
                {t("settings.idePresets.detect.button")}
              </Button>
              {detectedId !== null && (
                <span className="text-xs text-mid-gray/80">
                  {detectedId === "__none__"
                    ? t("settings.idePresets.detect.none")
                    : t("settings.idePresets.detect.matched", {
                        name:
                          presets.find((p) => p.id === detectedId)?.name ??
                          detectedId,
                      })}
                </span>
              )}
            </div>
          </SettingContainer>

          <SettingContainer
            title={t("settings.idePresets.list.title")}
            description={t("settings.idePresets.list.description")}
            descriptionMode={descriptionMode}
            grouped={grouped}
            layout="stacked"
          >
            <div className="space-y-3">
              {presets.map((preset) => {
                const hintSeen = seen.includes(preset.id);
                return (
                  <div
                    key={preset.id}
                    className="p-3 rounded-md border border-mid-gray/20"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">
                          {preset.name}
                        </span>
                        {preset.autoSubmit && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-logo-primary/20 text-logo-primary">
                            {t("settings.idePresets.badges.autoSubmit")}
                          </span>
                        )}
                        {hintSeen && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-mid-gray/20 text-mid-gray/80">
                            {t("settings.idePresets.badges.seen")}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      {preset.commands.map((c) => (
                        <div
                          key={c.phrase}
                          className="flex items-center gap-2 text-xs text-mid-gray/80"
                        >
                          <span className="font-mono text-text/90">
                            "{c.phrase}"
                          </span>
                          <span className="opacity-50">→</span>
                          <span className="font-mono text-logo-primary">
                            {formatKeystroke(c.keystroke)}
                          </span>
                          <span className="opacity-60 truncate">
                            {c.description}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </SettingContainer>

          <SettingContainer
            title={t("settings.idePresets.resetHints.title")}
            description={t("settings.idePresets.resetHints.description")}
            descriptionMode={descriptionMode}
            grouped={grouped}
            layout="horizontal"
          >
            <Button
              onClick={handleResetHints}
              variant="secondary"
              size="sm"
              disabled={seen.length === 0}
            >
              {t("settings.idePresets.resetHints.button")}
            </Button>
          </SettingContainer>
        </>
      )}
    </>
  );
};
