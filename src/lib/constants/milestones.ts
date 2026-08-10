/**
 * Dictation milestones — "you've spoken the length of ___".
 *
 * Each entry is a cumulative `lifetime_words` threshold (see `UsageStats`
 * from `getUsageStats()`) paired with a well-known work of roughly that
 * length. Crossing a threshold unlocks the comparison.
 *
 * The data itself lives in `shared/milestones.json`, which is the single
 * source of truth for both halves of the app: this module types it for the
 * sidebar, and `src-tauri/src/milestones.rs` embeds the same file with
 * `include_str!` so the Rust side can detect crossings and post a
 * notification while the settings window is closed. Two hand-maintained
 * copies would drift, and a drifted threshold means the notification
 * congratulates you on a different book than the sidebar shows.
 *
 * Word counts come from two places:
 *
 *   - Public-domain works were counted directly from the Project Gutenberg
 *     plain-text edition, with the PG license header/footer stripped and the
 *     remainder split on whitespace. That matches how a transcript's word
 *     count is computed, so the comparison is apples-to-apples. These counts
 *     run 1–4% above the figures publishers quote, because the Gutenberg text
 *     retains front matter, chapter headings, and (for translations) the
 *     translator's preface.
 *   - Everything still in copyright uses the commonly published figure.
 *     `approx` marks entries that are a stated estimate rather than a count
 *     of a specific edition — series totals, reference works, and the very
 *     short poems, where sources differ by a few words.
 *
 * `notable` marks the ~35 thresholds famous enough to interrupt someone for.
 * The sidebar advances through all of them; only these post a notification.
 *
 * The list is sorted ascending and every `words` value is unique, so a simple
 * scan finds the current and next milestone. Keep both invariants when adding
 * entries — `milestones.test.ts` asserts them.
 *
 * Titles and authors are proper nouns and deliberately stay out of
 * `translation.json`: they are not translated. The sentence that wraps them
 * ("You've dictated the length of {{title}}") is the translatable part and
 * belongs in the component.
 */

import milestoneData from "../../../shared/milestones.json";

export type MilestoneCategory =
  | "poem"
  | "speech"
  | "story"
  | "play"
  | "novel"
  | "epic"
  | "series"
  | "reference";

export interface Milestone {
  /** Cumulative lifetime words needed to unlock. Unique across the list. */
  words: number;
  /** Shown verbatim. Never translated. */
  title: string;
  /** Omitted for anonymous, collective, and reference works. */
  author?: string;
  category: MilestoneCategory;
  /** Count is a published estimate, not a measured edition. Render as "≈". */
  approx?: boolean;
  /** Famous enough to be worth a notification. See `milestones.rs`. */
  notable?: boolean;
}

export const MILESTONES: Milestone[] = milestoneData as Milestone[];

/**
 * The highest milestone reached, or `undefined` before the first one.
 * `MILESTONES` is sorted ascending, so the last match wins.
 */
export function currentMilestone(lifetimeWords: number): Milestone | undefined {
  let reached: Milestone | undefined;
  for (const milestone of MILESTONES) {
    if (milestone.words > lifetimeWords) break;
    reached = milestone;
  }
  return reached;
}

/** The next milestone to unlock, or `undefined` once the list runs out. */
export function nextMilestone(lifetimeWords: number): Milestone | undefined {
  return MILESTONES.find((milestone) => milestone.words > lifetimeWords);
}

/**
 * Progress from the previous milestone to the next, in the range 0–1.
 * Returns 1 when every milestone has been reached.
 */
export function milestoneProgress(lifetimeWords: number): number {
  const next = nextMilestone(lifetimeWords);
  if (!next) return 1;
  const floor = currentMilestone(lifetimeWords)?.words ?? 0;
  return (lifetimeWords - floor) / (next.words - floor);
}
