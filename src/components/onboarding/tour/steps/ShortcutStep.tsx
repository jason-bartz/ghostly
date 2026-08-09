import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Hand, Repeat } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { KeyCombo, StepHeader, Waveform } from "../parts";

/** The three beats of the gesture, in milliseconds. */
const BEATS = [1500, 2300, 2600] as const;

type HoldMode = "hold" | "toggle";

/**
 * Teaches the gesture by performing it.
 *
 * A screenshot of a keyboard shortcut teaches nothing about *when* the text
 * appears. The loop below plays press → speak → release → text lands, on the
 * user's own binding, so the mental model is set before they try it for real
 * on the next step.
 */
export const ShortcutStep: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const [beat, setBeat] = useState(0);

  const binding = settings?.bindings?.transcribe?.current_binding ?? "fn";
  const holdMode: HoldMode =
    settings?.push_to_talk === false ? "toggle" : "hold";
  const sample = t("tour.shortcut.sample");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setBeat((b) => (b + 1) % 3),
      BEATS[beat],
    );
    return () => window.clearTimeout(timer);
  }, [beat]);

  // Fake levels for the demo. Real audio arrives on the next step; here the
  // point is the shape of the interaction, not the meter.
  const demoLevels =
    beat === 1
      ? Array.from({ length: 8 }, (_, i) => 0.35 + Math.sin(i * 1.7) * 0.3)
      : [];

  const typed = beat === 2 ? sample : "";

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        eyebrow={t("tour.shortcut.eyebrow")}
        title={
          holdMode === "hold"
            ? t("tour.shortcut.titleHold")
            : t("tour.shortcut.titleToggle")
        }
        body={t("tour.shortcut.body")}
      />

      {/* The demo stage. Fixed height so the three beats never resize it. */}
      <div
        data-rise
        style={{ "--i": 1 } as React.CSSProperties}
        className="surface-card-inlay px-5 py-4 flex flex-col gap-3.5"
      >
        <div className="flex items-center justify-center gap-4 h-[46px]">
          <KeyCombo binding={binding} size="lg" pressed={beat === 1} />
          <div className="w-px h-7 bg-hairline" aria-hidden />
          <div className="w-[150px]">
            <Waveform levels={demoLevels} bars={15} height={34} />
          </div>
        </div>

        {/* The caption is the narration: it names the beat you're watching. */}
        <p className="text-center text-[12px] text-accent-bright font-medium h-4">
          {t(
            beat === 0
              ? holdMode === "hold"
                ? "tour.shortcut.beats.press"
                : "tour.shortcut.beats.pressToggle"
              : beat === 1
                ? "tour.shortcut.beats.speak"
                : holdMode === "hold"
                  ? "tour.shortcut.beats.release"
                  : "tour.shortcut.beats.releaseToggle",
          )}
        </p>

        {/* A stand-in text field. Text arrives on the third beat, exactly where
            a cursor would be. */}
        <div className="rounded-lg bg-fill-1 border border-hairline px-3 py-2.5 h-[52px] flex items-center">
          <p className="text-[13px] leading-snug text-text">
            {typed}
            <span className="tour-caret" aria-hidden />
          </p>
        </div>
      </div>

      <div
        data-rise
        style={{ "--i": 2 } as React.CSSProperties}
        className="surface-card px-4 py-3 flex items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-text">
            {t("tour.shortcut.mode.title")}
          </p>
          <p className="text-[11.5px] text-text-subtle leading-snug mt-0.5">
            {t(
              holdMode === "hold"
                ? "tour.shortcut.mode.holdBody"
                : "tour.shortcut.mode.toggleBody",
            )}
          </p>
        </div>
        <SegmentedControl<HoldMode>
          value={holdMode}
          ariaLabel={t("tour.shortcut.mode.title")}
          size="sm"
          options={[
            { value: "hold", label: t("tour.shortcut.mode.hold"), Icon: Hand },
            {
              value: "toggle",
              label: t("tour.shortcut.mode.toggle"),
              Icon: Repeat,
            },
          ]}
          onChange={(value) =>
            void updateSetting("push_to_talk", value === "hold")
          }
        />
      </div>

      <p
        data-rise
        style={{ "--i": 3 } as React.CSSProperties}
        className="text-[11.5px] text-text-faint text-center"
      >
        {t("tour.shortcut.rebindHint")}
      </p>
    </div>
  );
};

export default ShortcutStep;
