import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";

interface FillerWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

type Mode = "defaults" | "custom" | "disabled";

const modeOf = (value: string[] | null | undefined): Mode => {
  if (value === null || value === undefined) return "defaults";
  if (value.length === 0) return "disabled";
  return "custom";
};

export const FillerWords: React.FC<FillerWordsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newWord, setNewWord] = useState("");

    const raw = getSetting("custom_filler_words");
    const mode = modeOf(raw);
    const words = Array.isArray(raw) ? raw : [];
    const updating = isUpdating("custom_filler_words");

    const handleModeChange = (next: string) => {
      if (next === "defaults") updateSetting("custom_filler_words", null);
      else if (next === "disabled") updateSetting("custom_filler_words", []);
      else if (next === "custom" && mode !== "custom") {
        updateSetting("custom_filler_words", words.length ? words : ["um", "uh"]);
      }
    };

    const handleAdd = () => {
      const trimmed = newWord.trim().toLowerCase();
      const sanitized = trimmed.replace(/[<>"'&]/g, "");
      if (!sanitized || sanitized.length > 50) return;
      if (words.includes(sanitized)) {
        toast.error(
          t("settings.advanced.fillerWords.duplicate", { word: sanitized }),
        );
        return;
      }
      updateSetting("custom_filler_words", [...words, sanitized]);
      setNewWord("");
    };

    const handleRemove = (word: string) => {
      updateSetting(
        "custom_filler_words",
        words.filter((w) => w !== word),
      );
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    };

    const modeOptions = [
      { value: "defaults", label: t("settings.advanced.fillerWords.modes.defaults") },
      { value: "custom", label: t("settings.advanced.fillerWords.modes.custom") },
      { value: "disabled", label: t("settings.advanced.fillerWords.modes.disabled") },
    ];

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.fillerWords.title")}
          description={t("settings.advanced.fillerWords.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <Dropdown
            options={modeOptions}
            selectedValue={mode}
            onSelect={handleModeChange}
            disabled={updating}
            className="min-w-[200px]"
          />
        </SettingContainer>

        {mode === "custom" && (
          <>
            <SettingContainer
              title={t("settings.advanced.fillerWords.addTitle")}
              description={t("settings.advanced.fillerWords.addDescription")}
              descriptionMode={descriptionMode}
              grouped={grouped}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  className="max-w-40"
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  onKeyDown={handleKeyPress}
                  placeholder={t("settings.advanced.fillerWords.placeholder")}
                  variant="compact"
                  disabled={updating}
                />
                <Button
                  onClick={handleAdd}
                  disabled={!newWord.trim() || newWord.trim().length > 50 || updating}
                  variant="primary"
                  size="md"
                >
                  {t("settings.advanced.fillerWords.add")}
                </Button>
              </div>
            </SettingContainer>
            {words.length > 0 && (
              <div
                className={`px-4 p-2 ${grouped ? "" : "rounded-lg border border-mid-gray/20"} flex flex-wrap gap-1`}
              >
                {words.map((word) => (
                  <Button
                    key={word}
                    onClick={() => handleRemove(word)}
                    disabled={updating}
                    variant="secondary"
                    size="sm"
                    className="inline-flex items-center gap-1 cursor-pointer"
                    aria-label={t("settings.advanced.fillerWords.remove", { word })}
                  >
                    <span>{word}</span>
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
      </>
    );
  },
);
