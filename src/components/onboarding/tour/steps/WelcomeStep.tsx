import React from "react";
import { useTranslation } from "react-i18next";
import { CloudOff, Gauge, MousePointerClick } from "lucide-react";
import GhostlyMark from "@/components/icons/GhostlyMark";
import { StepHeader } from "../parts";

const PROOF = [
  { key: "private", Icon: CloudOff },
  { key: "fast", Icon: Gauge },
  { key: "anywhere", Icon: MousePointerClick },
] as const;

/**
 * The brand moment.
 *
 * It makes one promise and proves it three ways, then gets out of the way.
 * Nothing here is configurable, and it deliberately asks for nothing — the
 * first thing a new user does should not be a decision.
 */
export const WelcomeStep: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-7 pt-2">
      <div
        data-rise
        className="relative flex items-center justify-center h-[132px] w-full"
      >
        <span className="tour-halo" aria-hidden />
        <GhostlyMark
          height={104}
          className="tour-float relative text-accent-bright drop-shadow-[0_12px_28px_var(--color-accent-glow)]"
        />
      </div>

      <StepHeader
        index={1}
        eyebrow={t("tour.welcome.eyebrow")}
        title={t("tour.welcome.title")}
        body={t("tour.welcome.body")}
      />

      <div className="grid grid-cols-3 gap-2.5 w-full">
        {PROOF.map(({ key, Icon }, i) => (
          <div
            key={key}
            data-rise
            style={{ "--i": 2 + i } as React.CSSProperties}
            className="surface-card px-3.5 py-3.5 flex flex-col gap-2"
          >
            <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-accent/10 border border-accent/20">
              <Icon className="w-3.5 h-3.5 text-accent-bright" />
            </span>
            <p className="text-[12px] font-medium text-text leading-snug">
              {t(`tour.welcome.proof.${key}.title`)}
            </p>
            <p className="text-[11.5px] text-text-subtle leading-snug">
              {t(`tour.welcome.proof.${key}.body`)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WelcomeStep;
