import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MenuSquare, NotebookPen, RotateCcw } from "lucide-react";
import GhostlyMark from "@/components/icons/GhostlyMark";
import { useSettings } from "@/hooks/useSettings";
import { KeyCombo, StepHeader } from "../parts";
import type { ModelUpgradeState } from "../useModelUpgrade";
import type { TourStepProps } from "../types";

const WHERE = [
  { key: "tray", Icon: MenuSquare },
  { key: "notes", Icon: NotebookPen },
  { key: "replay", Icon: RotateCcw },
] as const;

interface FinishStepProps extends TourStepProps {
  upgrade: ModelUpgradeState;
  errorReports: boolean;
  onErrorReportsChange: (value: boolean) => void;
}

/**
 * The send-off.
 *
 * Its real job is the three lines under "where things live": the tray icon,
 * the notes timeline, and how to get this tour back. A user who knows where
 * the app went is a user who opens it again.
 */
export const FinishStep: React.FC<FinishStepProps> = ({
  mode,
  upgrade,
  errorReports,
  onErrorReportsChange,
  setFooter,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const binding = settings?.bindings?.transcribe?.current_binding ?? "fn";

  useEffect(() => {
    setFooter({ primaryLabel: t("tour.finish.cta") });
  }, [setFooter, t]);

  return (
    <div className="flex flex-col items-center gap-5">
      <div
        data-rise
        className="relative flex items-center justify-center h-[86px] w-full"
      >
        <span className="tour-halo" aria-hidden />
        <GhostlyMark
          height={68}
          className="tour-float relative text-accent-bright"
        />
      </div>

      <StepHeader
        index={1}
        title={t("tour.finish.title")}
        body={t("tour.finish.body")}
      />

      <div
        data-rise
        style={{ "--i": 2 } as React.CSSProperties}
        className="section-band-accent w-full flex items-center justify-center gap-3"
      >
        <span className="text-[12.5px] text-text-muted">
          {t("tour.finish.reminder")}
        </span>
        <KeyCombo binding={binding} />
      </div>

      <div className="w-full flex flex-col gap-1.5">
        {WHERE.map(({ key, Icon }, i) => (
          <div
            key={key}
            data-rise
            style={{ "--i": 3 + i } as React.CSSProperties}
            className="flex items-center gap-3 px-3.5 py-2.5 rounded-lg bg-fill-1 border border-hairline"
          >
            <Icon className="w-3.5 h-3.5 text-text-subtle shrink-0" />
            <p className="text-[12px] text-text-muted leading-snug">
              {t(`tour.finish.where.${key}`)}
            </p>
          </div>
        ))}
      </div>

      {/* Background model upgrade — informational, never a gate. */}
      {upgrade.active && (
        <div
          data-rise
          style={{ "--i": 6 } as React.CSSProperties}
          className="w-full surface-card px-4 py-3"
        >
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-[12px] font-medium text-text">
              {t("tour.finish.upgrade.title")}
            </p>
            <span className="text-[11px] tabular-nums text-text-faint">
              {`${Math.round(upgrade.progress)}%`}
            </span>
          </div>
          <div className="w-full h-1 bg-fill-4 rounded-full overflow-hidden">
            <div
              className="h-full min-w-[2px] bg-gradient-to-r from-accent to-accent-deep rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${upgrade.progress}%` }}
            />
          </div>
          <p className="text-[11.5px] text-text-faint leading-snug mt-2">
            {t("tour.finish.upgrade.body")}
          </p>
        </div>
      )}

      {/* Asked once, unchecked, with the promise stated inline. */}
      {mode === "first-run" && (
        <label
          data-rise
          style={{ "--i": 7 } as React.CSSProperties}
          className="w-full flex items-start gap-2.5 px-1 cursor-pointer group"
        >
          <input
            type="checkbox"
            checked={errorReports}
            onChange={(e) => onErrorReportsChange(e.target.checked)}
            className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded accent-[var(--color-accent-deep)] cursor-pointer"
          />
          <span className="text-[11.5px] text-text-faint leading-relaxed group-hover:text-text-muted transition-colors">
            {t("tour.finish.errorReports")}
          </span>
        </label>
      )}
    </div>
  );
};

export default FinishStep;
