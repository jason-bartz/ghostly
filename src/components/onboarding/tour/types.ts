/** How the tour was entered — it changes what the flow is allowed to do. */
export type TourMode =
  /** First launch. Writes the onboarding-complete flag and asks for the
   *  one-time error-reporting consent. */
  | "first-run"
  /** Replayed from Settings. Purely educational: no consent prompt, no flag
   *  writes beyond whatever a step's own controls change. */
  | "replay"
  /** A returning user is missing a permission. Shows the permission step
   *  alone and leaves as soon as it's satisfied. */
  | "permissions";

export type TourStepId =
  | "welcome"
  | "permissions"
  | "shortcut"
  | "practice"
  | "refinement"
  | "features"
  | "finish";

export interface TourStepProps {
  mode: TourMode;
  /** Advance to the next step. On the last step this finishes the tour. */
  onNext: () => void;
  /** Lets a step drive the footer's primary button copy and enabled state. */
  setFooter: (footer: TourFooterState) => void;
}

export interface TourFooterState {
  /** Primary button label. Falls back to the step's default when omitted. */
  primaryLabel?: string;
  primaryDisabled?: boolean;
  /** A quiet line of guidance rendered to the left of the buttons. */
  hint?: string;
}
