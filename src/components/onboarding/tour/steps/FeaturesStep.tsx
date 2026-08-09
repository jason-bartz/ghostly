import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookA, Camera, Palette, PenLine, Quote } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { KeyCombo, StepHeader } from "../parts";
import type { TourStepProps } from "../types";

/** How long each card holds before advancing. */
const DWELL_MS = 5200;

interface Feature {
  key: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Binding id to render as keycaps, when the feature has one. */
  bindingId?: string;
}

const FEATURES: Feature[] = [
  { key: "verbatim", Icon: Quote, bindingId: "transcribe_verbatim" },
  { key: "editLast", Icon: PenLine, bindingId: "edit_last_transcription" },
  {
    key: "screenshot",
    Icon: Camera,
    bindingId: "transcribe_with_screenshot",
  },
  { key: "styles", Icon: Palette },
  { key: "dictionary", Icon: BookA },
];

/**
 * The reason this tour exists.
 *
 * Ghostly's depth — verbatim mode, edit-last, screenshot Q&A, per-app styles,
 * the dictionary — is invisible from the main window, so most users never meet
 * it. One card at a time, each showing the real shortcut as bound on *this*
 * machine.
 *
 * The three headline features live on the previous step instead: a card that
 * auto-advances is a card that can be missed, and those three can't afford to
 * be. What's left here is the shortcut layer, which is exactly the kind of
 * thing a timed carousel is good at.
 *
 * It advances on a timer because a row of five cards gets skimmed and none of
 * them get read. The dot rail fills as the timer runs, so the movement is
 * always announced, and any interaction stops the timer for good — once
 * someone is steering, taking the wheel back is rude.
 */
export const FeaturesStep: React.FC<TourStepProps> = ({ setFooter }) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setFooter({ hint: t("tour.features.hint") });
  }, [setFooter, t]);

  useEffect(() => {
    if (!auto) return;
    timerRef.current = window.setTimeout(
      () => setIndex((i) => (i + 1) % FEATURES.length),
      DWELL_MS,
    );
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [index, auto]);

  const select = useCallback((next: number) => {
    setAuto(false);
    setIndex((next + FEATURES.length) % FEATURES.length);
  }, []);

  // Arrow keys steer the carousel, which is also what makes the dot rail
  // reachable without a mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") select(index + 1);
      else if (e.key === "ArrowLeft") select(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, select]);

  const feature = FEATURES[index];
  const Icon = feature.Icon;
  const binding = feature.bindingId
    ? (settings?.bindings?.[feature.bindingId]?.current_binding ?? "")
    : "";

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        eyebrow={t("tour.features.eyebrow")}
        title={t("tour.features.title")}
        body={t("tour.features.body")}
      />

      {/* Fixed height: every card occupies exactly the same box, so advancing
          never nudges the footer. */}
      <div
        data-rise
        style={{ "--i": 1 } as React.CSSProperties}
        className="surface-card-inlay h-[158px] px-5 py-4 flex"
      >
        <div key={feature.key} className="tour-card-in flex gap-4 w-full">
          <span className="flex items-center justify-center w-11 h-11 rounded-xl bg-accent/10 border border-accent/20 shrink-0">
            <Icon className="w-5 h-5 text-accent-bright" />
          </span>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-[15px] font-display tracking-tight text-text">
                {t(`tour.features.items.${feature.key}.title`)}
              </h3>
              {binding && <KeyCombo binding={binding} />}
            </div>
            <p className="text-[12.5px] text-text-muted leading-relaxed mt-1.5">
              {t(`tour.features.items.${feature.key}.body`)}
            </p>
            <p className="italic-serif text-[13px] text-accent-bright leading-snug mt-auto">
              {t(`tour.features.items.${feature.key}.example`)}
            </p>
          </div>
        </div>
      </div>

      {/* Dot rail — also the progress meter for the auto-advance. */}
      <div
        data-rise
        style={{ "--i": 2 } as React.CSSProperties}
        className="flex items-center justify-center gap-1.5"
      >
        {FEATURES.map((item, i) => (
          <button
            key={item.key}
            type="button"
            onClick={() => select(i)}
            aria-label={t(`tour.features.items.${item.key}.title`)}
            className={`h-1.5 rounded-full overflow-hidden transition-all duration-300 cursor-pointer ${
              i === index ? "w-8 bg-fill-4" : "w-1.5 bg-fill-3 hover:bg-fill-4"
            }`}
          >
            {i === index && (
              <span
                key={`${index}-${auto}`}
                className={`block h-full w-full bg-accent ${auto ? "tour-dot-fill" : ""}`}
                style={{ "--dwell": `${DWELL_MS}ms` } as React.CSSProperties}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default FeaturesStep;
