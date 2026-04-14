import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";
import { ToggleSwitch } from "../ui";

export const CorrectionPhrases: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const [newPhrase, setNewPhrase] = useState("");

  const enabled =
    (getSetting("correction_phrases_enabled") as boolean) ?? false;
  const phrases = (getSetting("correction_phrases") as string[]) ?? [
    "scratch that",
  ];

  const handleAdd = () => {
    const trimmed = newPhrase.trim().toLowerCase();
    if (!trimmed || trimmed.length > 60) return;
    if (phrases.includes(trimmed)) {
      toast.error(
        t("settings.correctionPhrases.duplicate", { phrase: trimmed }),
      );
      return;
    }
    updateSetting("correction_phrases" as any, [...phrases, trimmed] as any);
    setNewPhrase("");
  };

  const handleRemove = (phrase: string) => {
    updateSetting(
      "correction_phrases" as any,
      phrases.filter((p) => p !== phrase) as any,
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <>
      <ToggleSwitch
        label={t("settings.correctionPhrases.enable.title")}
        description={t("settings.correctionPhrases.enable.description")}
        checked={enabled}
        onChange={(v) =>
          updateSetting("correction_phrases_enabled" as any, v as any)
        }
        isUpdating={isUpdating("correction_phrases_enabled")}
        grouped={true}
      />

      {enabled && (
        <>
          <SettingContainer
            title={t("settings.correctionPhrases.phrasesTitle")}
            description={t("settings.correctionPhrases.phrasesDescription")}
            descriptionMode="tooltip"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <Input
                type="text"
                className="max-w-56"
                value={newPhrase}
                onChange={(e) => setNewPhrase(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("settings.correctionPhrases.placeholder")}
                variant="compact"
                disabled={isUpdating("correction_phrases")}
              />
              <Button
                onClick={handleAdd}
                disabled={!newPhrase.trim() || isUpdating("correction_phrases")}
                variant="primary"
                size="md"
              >
                {t("settings.correctionPhrases.add")}
              </Button>
            </div>
          </SettingContainer>

          {phrases.length > 0 && (
            <div className="px-4 p-2 flex flex-wrap gap-1">
              {phrases.map((phrase) => (
                <Button
                  key={phrase}
                  onClick={() => handleRemove(phrase)}
                  disabled={isUpdating("correction_phrases")}
                  variant="secondary"
                  size="sm"
                  className="inline-flex items-center gap-1 cursor-pointer"
                  aria-label={t("settings.correctionPhrases.remove", {
                    phrase,
                  })}
                >
                  <span>{phrase}</span>
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
});

CorrectionPhrases.displayName = "CorrectionPhrases";
