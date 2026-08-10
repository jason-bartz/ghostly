import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { Slider } from "../ui/Slider";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Dropdown } from "../ui/Dropdown";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "../../bindings";

interface Props {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ContinuousDictation: React.FC<Props> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const enabled =
    (getSetting("continuous_dictation_enabled") as boolean) ?? false;
  const silenceMs = (getSetting("continuous_silence_ms") as number) ?? 900;
  const maxMs = (getSetting("continuous_max_segment_ms") as number) ?? 20000;
  const minMs = (getSetting("continuous_min_segment_ms") as number) ?? 400;
  const submitPhraseEnabled =
    (getSetting("continuous_submit_phrase_enabled") as boolean) ?? false;
  const submitPhrase =
    (getSetting("continuous_submit_phrase") as string) ?? "send it";
  const submitKey = (getSetting("continuous_submit_key") as string) ?? "enter";

  const [armed, setArmed] = useState(false);

  // The phrase is edited locally and committed on blur or Enter.
  //
  // It used to call `updateSetting` on every keystroke, and each of those is a
  // backend read-modify-write of the whole settings blob — so typing "send"
  // fired four racing `get_settings → mutate → write_settings` round trips and
  // a shorter earlier value could land after a longer later one. The field
  // appeared to save, then silently reverted to something truncated or stale.
  // `null` means "show the saved value".
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);

  const commitPhrase = () => {
    if (phraseDraft === null) return;
    const next = phraseDraft.trim();
    setPhraseDraft(null);
    if (next !== submitPhrase) updateSetting("continuous_submit_phrase", next);
  };

  useEffect(() => {
    let active = true;
    commands.isContinuousDictationArmed().then((v) => {
      if (active) setArmed(v);
    });
    const unlisten = listen<boolean>("continuous-dictation-armed", (evt) => {
      if (active) setArmed(!!evt.payload);
    });
    return () => {
      active = false;
      unlisten.then((u) => u());
    };
  }, []);

  const toggleArmed = async () => {
    const res = await commands.setContinuousDictationArmed(!armed);
    if (res.status === "error") {
      console.error("Failed to toggle continuous dictation:", res.error);
    }
  };

  // Rendered as a flat list of rows, not a nested `space-y` stack: the parent
  // SettingsGroup draws hairlines between its direct children, so a wrapper
  // div would collapse the whole panel into one undivided row and leave the
  // free-standing controls without the group's horizontal padding.
  return (
    <>
      <ToggleSwitch
        checked={enabled}
        onChange={(v) => updateSetting("continuous_dictation_enabled", v)}
        isUpdating={isUpdating("continuous_dictation_enabled")}
        label={t("settings.advanced.continuousDictation.label")}
        description={t("settings.advanced.continuousDictation.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />

      {enabled && (
        <>
          <Alert variant="warning" contained={grouped}>
            {t("settings.advanced.continuousDictation.warning")}
          </Alert>

          <div className="flex items-center gap-3 px-4 py-3">
            <Button
              variant={armed ? "danger" : "primary"}
              onClick={toggleArmed}
            >
              {armed
                ? t("settings.advanced.continuousDictation.disarm")
                : t("settings.advanced.continuousDictation.arm")}
            </Button>
            <span className="text-[13px] text-text-muted">
              {armed
                ? t("settings.advanced.continuousDictation.statusArmed")
                : t("settings.advanced.continuousDictation.statusDisarmed")}
            </span>
          </div>

          <Slider
            value={silenceMs}
            onChange={(v) =>
              updateSetting("continuous_silence_ms", Math.round(v))
            }
            min={300}
            max={2500}
            step={50}
            label={t("settings.advanced.continuousDictation.silenceLabel")}
            description={t(
              "settings.advanced.continuousDictation.silenceDescription",
            )}
            descriptionMode={descriptionMode}
            grouped={grouped}
            formatValue={(v) => `${Math.round(v)} ms`}
          />

          <Slider
            value={minMs}
            onChange={(v) =>
              updateSetting("continuous_min_segment_ms", Math.round(v))
            }
            min={0}
            max={1500}
            step={50}
            label={t("settings.advanced.continuousDictation.minLabel")}
            description={t(
              "settings.advanced.continuousDictation.minDescription",
            )}
            descriptionMode={descriptionMode}
            grouped={grouped}
            formatValue={(v) => `${Math.round(v)} ms`}
          />

          <Slider
            value={maxMs}
            onChange={(v) =>
              updateSetting("continuous_max_segment_ms", Math.round(v))
            }
            min={5000}
            max={60000}
            step={1000}
            label={t("settings.advanced.continuousDictation.maxLabel")}
            description={t(
              "settings.advanced.continuousDictation.maxDescription",
            )}
            descriptionMode={descriptionMode}
            grouped={grouped}
            formatValue={(v) => `${(v / 1000).toFixed(0)} s`}
          />

          <ToggleSwitch
            checked={submitPhraseEnabled}
            onChange={(v) =>
              updateSetting("continuous_submit_phrase_enabled", v)
            }
            isUpdating={isUpdating("continuous_submit_phrase_enabled")}
            label={t("settings.advanced.continuousDictation.submitPhraseLabel")}
            description={t(
              "settings.advanced.continuousDictation.submitPhraseDescription",
            )}
            descriptionMode={descriptionMode}
            grouped={grouped}
          />

          {submitPhraseEnabled && (
            /* The phrase field takes the slack and the key picker keeps its
               intrinsic width — boxing the Dropdown into a narrower column
               fought its own min-width and pushed it past the card edge. */
            <div className="flex items-center gap-3 px-4 py-3">
              <Input
                type="text"
                className="flex-1 min-w-0"
                value={phraseDraft ?? submitPhrase}
                onChange={(e) => setPhraseDraft(e.target.value)}
                onBlur={commitPhrase}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitPhrase();
                  if (e.key === "Escape") setPhraseDraft(null);
                }}
                placeholder={t(
                  "settings.advanced.continuousDictation.submitPhrasePlaceholder",
                )}
              />
              <Dropdown
                className="shrink-0"
                options={[
                  {
                    value: "enter",
                    label: t(
                      "settings.advanced.continuousDictation.submitKeyEnter",
                    ),
                  },
                  {
                    value: "cmd_enter",
                    label: t(
                      "settings.advanced.continuousDictation.submitKeyCmdEnter",
                    ),
                  },
                ]}
                selectedValue={submitKey}
                onSelect={(v) =>
                  updateSetting("continuous_submit_key", v as any)
                }
                disabled={isUpdating("continuous_submit_key")}
              />
            </div>
          )}
        </>
      )}
    </>
  );
};
