import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Mic, NotebookPen, Users } from "lucide-react";
import { StepHeader } from "../parts";
import type { TourStepProps } from "../types";

interface Highlight {
  key: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const HIGHLIGHTS: Highlight[] = [
  { key: "notes", Icon: NotebookPen },
  { key: "meetings", Icon: Users },
  { key: "openMic", Icon: Mic },
];

/**
 * The three features people would never find on their own.
 *
 * These deliberately don't share the carousel with the shortcut-level
 * features: a card that auto-advances is a card that can be missed, and
 * Notes, Meeting Mode and Open Mic are the three things that make Ghostly
 * something other than a dictation box. All three are on screen at once, with
 * no timer, so leaving this step means having seen them.
 *
 * Every card names where it actually lives. A feature the user can't find
 * after being shown it is worse than one they were never shown.
 *
 * No shortcuts are displayed here: Meeting Mode ships unbound, and Open Mic's
 * binding does nothing until the feature is switched on. A keycap that doesn't
 * work is a support ticket.
 */
export const HighlightsStep: React.FC<TourStepProps> = ({ setFooter }) => {
  const { t } = useTranslation();

  useEffect(() => {
    setFooter({ hint: t("tour.highlights.hint") });
  }, [setFooter, t]);

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        eyebrow={t("tour.highlights.eyebrow")}
        title={t("tour.highlights.title")}
        body={t("tour.highlights.body")}
      />

      <div className="flex flex-col gap-2">
        {HIGHLIGHTS.map(({ key, Icon }, i) => (
          <div
            key={key}
            data-rise
            style={{ "--i": 1 + i } as React.CSSProperties}
            className="surface-card px-4 py-3 flex items-start gap-3.5"
          >
            <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 shrink-0">
              <Icon className="w-4 h-4 text-accent-bright" />
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-[14px] font-display tracking-tight text-text">
                {t(`tour.highlights.items.${key}.title`)}
              </h3>
              <p className="text-[12.5px] text-text-muted leading-snug mt-0.5">
                {t(`tour.highlights.items.${key}.body`)}
              </p>
              <p className="text-[11.5px] text-text-faint leading-snug mt-1">
                {t(`tour.highlights.items.${key}.where`)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default HighlightsStep;
