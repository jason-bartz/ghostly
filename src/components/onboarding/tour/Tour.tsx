import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import GhostlyLogo from "@/components/icons/GhostwriterLogo";
import "./tour.css";
import { useModelUpgrade } from "./useModelUpgrade";
import type { TourFooterState, TourMode, TourStepId } from "./types";
import WelcomeStep from "./steps/WelcomeStep";
import PermissionsStep from "./steps/PermissionsStep";
import ShortcutStep from "./steps/ShortcutStep";
import PracticeStep from "./steps/PracticeStep";
import RefinementStep from "./steps/RefinementStep";
import MeetingsStep from "./steps/MeetingsStep";
import FeaturesStep from "./steps/FeaturesStep";
import FinishStep from "./steps/FinishStep";

/** Matches the exit animation in tour.css. */
const EXIT_MS = 180;

const FULL_FLOW: TourStepId[] = [
  "welcome",
  "permissions",
  "shortcut",
  "practice",
  "refinement",
  "meetings",
  "features",
  "finish",
];

interface TourProps {
  mode: TourMode;
  onComplete: () => void;
}

/**
 * Ghostly's guided tour.
 *
 * Three things are deliberate about the shell:
 *
 * **One fixed frame.** The stage never resizes between steps. A card that
 * grows and shrinks as you advance makes the whole flow feel improvised, and
 * on a desktop app it drags the eye away from the content on every click. Long
 * steps scroll inside the frame instead, behind a soft mask.
 *
 * **The progress rail is honest.** Segments, not a percentage — the user can
 * see exactly how many steps remain, which is the single cheapest thing an
 * onboarding flow can do for completion rate.
 *
 * **Every step is skippable and nothing is destructive.** Skip finishes the
 * flow rather than trapping the user; the tour can be replayed from Settings,
 * so there is no cost to leaving early.
 */
export const Tour: React.FC<TourProps> = ({ mode, onComplete }) => {
  const { t } = useTranslation();

  const steps = useMemo<TourStepId[]>(
    () => (mode === "permissions" ? ["permissions"] : FULL_FLOW),
    [mode],
  );

  const [index, setIndex] = useState(0);
  const [rendered, setRendered] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [exiting, setExiting] = useState(false);
  const [footer, setFooterState] = useState<TourFooterState>({});
  const [errorReports, setErrorReports] = useState(false);
  const finishingRef = useRef(false);
  const swapTimerRef = useRef<number | null>(null);

  // Only a first run should install the upgrade model; a replay must not kick
  // off a 400 MB download for someone who already chose a different tier.
  const upgrade = useModelUpgrade(mode === "first-run");

  const step = steps[rendered];
  const isLast = index === steps.length - 1;

  const finish = useCallback(async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (mode === "first-run") {
      try {
        if (errorReports) {
          await commands.changeErrorReportingSetting(true);
        } else {
          await commands.markErrorReportingPrompted();
        }
        await commands.completeOnboarding();
      } catch (e) {
        // A failed flag write must not strand the user on the tour — the
        // backend re-checks on next launch and they can replay from Settings.
        console.error("Failed to finalize onboarding:", e);
      }
    }
    onComplete();
  }, [mode, errorReports, onComplete]);

  const go = useCallback(
    (next: number) => {
      if (exiting) return;
      if (next >= steps.length) {
        void finish();
        return;
      }
      if (next < 0) return;
      setDirection(next > index ? "forward" : "back");
      setIndex(next);
      setExiting(true);
      swapTimerRef.current = window.setTimeout(() => {
        setFooterState({});
        setRendered(next);
        setExiting(false);
      }, EXIT_MS);
    },
    [exiting, finish, index, steps.length],
  );

  useEffect(
    () => () => {
      if (swapTimerRef.current) window.clearTimeout(swapTimerRef.current);
    },
    [],
  );

  const onNext = useCallback(() => go(index + 1), [go, index]);
  const onBack = useCallback(() => go(index - 1), [go, index]);

  // Stable identity: steps call this from an effect, so a new function every
  // render would loop.
  const setFooter = useCallback((next: TourFooterState) => {
    setFooterState((prev) =>
      prev.primaryLabel === next.primaryLabel &&
      prev.primaryDisabled === next.primaryDisabled &&
      prev.hint === next.hint
        ? prev
        : next,
    );
  }, []);

  // Enter advances. Escape deliberately does *not* leave the tour: Escape is
  // the default binding for cancelling a recording, so a user who mis-speaks
  // on the practice step would otherwise dismiss the whole flow trying to
  // start over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || footer.primaryDisabled) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable;
      if (typing) return;
      e.preventDefault();
      onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNext, footer.primaryDisabled]);

  const stepProps = { mode, onNext, setFooter };

  const body = (() => {
    switch (step) {
      case "welcome":
        return <WelcomeStep />;
      case "permissions":
        return <PermissionsStep {...stepProps} />;
      case "shortcut":
        return <ShortcutStep />;
      case "practice":
        return <PracticeStep {...stepProps} />;
      case "refinement":
        return <RefinementStep {...stepProps} />;
      case "meetings":
        return <MeetingsStep {...stepProps} />;
      case "features":
        return <FeaturesStep {...stepProps} />;
      case "finish":
        return (
          <FinishStep
            {...stepProps}
            upgrade={upgrade}
            errorReports={errorReports}
            onErrorReportsChange={setErrorReports}
          />
        );
    }
  })();

  const transitionClass = exiting
    ? `tour-step-exit-${direction}`
    : `tour-step-enter-${direction}`;

  // A one-step flow has nothing to show progress against, but it still needs
  // an exit: macOS can leave the permission dialog in a state only a relaunch
  // clears, and trapping the user there is worse than letting them in.
  const showProgress = steps.length > 1;

  return (
    <div
      className="app-canvas h-screen w-screen flex items-center justify-center p-4 select-none cursor-default"
      role="dialog"
      aria-modal="true"
      aria-label={t("tour.ariaLabel")}
    >
      {/* One frame, every step. The height is fixed rather than fluid so the
          flow never resizes under the user — and capped against the viewport
          so it still fits at the window's minimum size. */}
      <div className="glass-raised rounded-3xl w-[664px] h-[628px] max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden">
        {/* ---- Header: identity, progress, exit ---- */}
        <div className="shrink-0 px-6 pt-5 pb-4 flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-4">
            <GhostlyLogo width={92} />
            <div className="flex items-center gap-3">
              {showProgress && (
                <span className="text-[11px] tabular-nums text-text-faint">
                  {t("tour.progress", {
                    current: index + 1,
                    total: steps.length,
                  })}
                </span>
              )}
              {/* Nothing left to skip on the last step — the primary button
                  already does exactly what this would. */}
              {!isLast && (
                <button
                  type="button"
                  onClick={() => void finish()}
                  className="text-[11.5px] text-text-faint hover:text-text-muted transition-colors cursor-pointer"
                >
                  {mode === "replay"
                    ? t("tour.close")
                    : mode === "permissions"
                      ? t("tour.skipForNow")
                      : t("tour.skip")}
                </button>
              )}
            </div>
          </div>

          {showProgress && (
            <div className="flex items-center gap-1" aria-hidden>
              {steps.map((id, i) => (
                <span
                  key={id}
                  className="h-[3px] flex-1 rounded-full bg-fill-3 overflow-hidden"
                >
                  <span
                    className={`block h-full rounded-full bg-gradient-to-r from-accent-deep to-accent transition-[width] duration-500 ease-out ${
                      i <= index ? "w-full" : "w-0"
                    }`}
                  />
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ---- Body: the one region that changes ---- */}
        <div className="flex-1 min-h-0 px-6">
          <div key={step} className={`tour-scroll h-full ${transitionClass}`}>
            {/* `min-h-full` + `justify-center` centres a short step inside the
                fixed frame while letting a tall one grow past it and scroll —
                the version of vertical centring that doesn't clip overflow. */}
            <div className="min-h-full flex flex-col justify-center py-2">
              {body}
            </div>
          </div>
        </div>

        {/* ---- Footer: hint on the left, navigation on the right ---- */}
        <div className="shrink-0 px-6 py-4 flex items-center justify-between gap-4 border-t border-hairline">
          <p className="text-[11.5px] text-text-faint leading-snug min-w-0 flex-1">
            {footer.hint ?? ""}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {index > 0 && (
              <Button variant="ghost" size="md" onClick={onBack}>
                <ArrowLeft className="w-3.5 h-3.5 me-1.5" />
                {t("tour.back")}
              </Button>
            )}
            <Button
              variant="primary"
              size="md"
              disabled={footer.primaryDisabled}
              onClick={onNext}
              className="gap-1.5 min-w-[104px]"
            >
              {footer.primaryLabel ??
                (isLast ? t("tour.finish.cta") : t("tour.continue"))}
              {!isLast && <ArrowRight className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Tour;
