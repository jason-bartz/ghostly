import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { commands } from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import {
  formatKeyCombination,
  getKeyName,
  normalizeKey,
} from "@/lib/utils/keyboard";
import { toast } from "sonner";

interface PromptShortcutInputProps {
  promptId: string;
  currentShortcut: string | null;
  promptName: string;
  onShortcutChange: () => void; // call to refresh settings after change
}

/**
 * Inline shortcut recorder for per-prompt keyboard shortcuts.
 * Stores the shortcut on the LLMPrompt itself (not in the global bindings map).
 */
export const PromptShortcutInput: React.FC<PromptShortcutInputProps> = ({
  promptId,
  currentShortcut,
  promptName,
  onShortcutChange,
}) => {
  const { t } = useTranslation();
  const osType = useOsType();
  const [isRecording, setIsRecording] = useState(false);
  const [keyPressed, setKeyPressed] = useState<string[]>([]);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRecording) return;

    let cleanup = false;
    const modifiers = [
      "ctrl",
      "control",
      "shift",
      "alt",
      "option",
      "meta",
      "command",
      "cmd",
      "super",
      "win",
      "windows",
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      if (cleanup) return;
      if (e.repeat) return;
      e.preventDefault();
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);
      setKeyPressed((prev) => (prev.includes(key) ? prev : [...prev, key]));
      setRecordedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    };

    const handleKeyUp = async (e: KeyboardEvent) => {
      if (cleanup) return;
      e.preventDefault();
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);
      const updatedPressed = keyPressed.filter((k) => k !== key);
      setKeyPressed(updatedPressed);

      if (updatedPressed.length === 0 && recordedKeys.length > 0) {
        const sorted = [...recordedKeys].sort((a, b) => {
          const aIsMod = modifiers.includes(a.toLowerCase());
          const bIsMod = modifiers.includes(b.toLowerCase());
          if (aIsMod && !bIsMod) return -1;
          if (!aIsMod && bIsMod) return 1;
          return 0;
        });
        const newShortcut = sorted.join("+");
        setIsRecording(false);
        setKeyPressed([]);
        setRecordedKeys([]);
        try {
          const result = await commands.setPromptShortcut(
            promptId,
            newShortcut,
          );
          if (result.status === "error") {
            toast.error(String(result.error));
          } else {
            onShortcutChange();
          }
        } catch (err) {
          toast.error(String(err));
        }
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (cleanup) return;
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsRecording(false);
        setKeyPressed([]);
        setRecordedKeys([]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("click", handleClickOutside);

    return () => {
      cleanup = true;
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("click", handleClickOutside);
    };
  }, [
    isRecording,
    keyPressed,
    recordedKeys,
    promptId,
    osType,
    onShortcutChange,
  ]);

  const handleClear = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const result = await commands.removePromptShortcut(promptId);
      if (result.status === "error") {
        toast.error(String(result.error));
      } else {
        onShortcutChange();
      }
    } catch (err) {
      toast.error(String(err));
    }
  };

  const displayLabel = isRecording
    ? recordedKeys.length > 0
      ? formatKeyCombination(recordedKeys.join("+"), osType)
      : t("settings.general.shortcut.pressKeys", "Press keys…")
    : currentShortcut
      ? formatKeyCombination(currentShortcut, osType)
      : t("settings.postProcessing.prompts.shortcut.none", "No shortcut");

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-semibold">
        {t("settings.postProcessing.prompts.shortcut.label", "Shortcut")}
      </label>
      <div ref={containerRef} className="flex items-center gap-2">
        <div
          onClick={() => {
            setIsRecording(true);
            setKeyPressed([]);
            setRecordedKeys([]);
          }}
          className={`px-2 py-1 text-sm font-semibold rounded-md cursor-pointer border transition-colors ${
            isRecording
              ? "border-logo-primary bg-logo-primary/30"
              : currentShortcut
                ? "bg-mid-gray/10 border-mid-gray/80 hover:bg-logo-primary/10 hover:border-logo-primary"
                : "bg-mid-gray/5 border-mid-gray/40 text-text/40 hover:bg-logo-primary/10 hover:border-logo-primary hover:text-text"
          }`}
        >
          {displayLabel}
        </div>
        {currentShortcut && !isRecording && (
          <button
            onClick={handleClear}
            className="p-1 rounded text-text/40 hover:text-text/80 transition-colors"
            title={t(
              "settings.postProcessing.prompts.shortcut.clear",
              "Remove shortcut",
            )}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <p className="text-xs text-mid-gray/60">
        {t(
          "settings.postProcessing.prompts.shortcut.description",
          "Press this shortcut to transcribe and apply this prompt directly.",
        )}
      </p>
    </div>
  );
};
