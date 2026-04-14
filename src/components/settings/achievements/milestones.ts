/**
 * Literary milestones used by the Achievements progress card.
 *
 * Word counts are approximate figures commonly cited in publishing references;
 * they are used for celebratory comparison, not as precise claims. The list is
 * intentionally mixed across genres and eras, ordered strictly by word count
 * so the ladder always progresses forward.
 */
export interface LiteraryMilestone {
  readonly words: number;
  readonly titleKey: string;
  readonly authorKey: string | null;
}

export const LITERARY_MILESTONES: readonly LiteraryMilestone[] = [
  {
    words: 1_000,
    titleKey: "achievements.milestones.blogPost",
    authorKey: null,
  },
  {
    words: 7_500,
    titleKey: "achievements.milestones.oldManSea",
    authorKey: "achievements.authors.hemingway",
  },
  {
    words: 26_000,
    titleKey: "achievements.milestones.animalFarm",
    authorKey: "achievements.authors.orwell",
  },
  {
    words: 47_000,
    titleKey: "achievements.milestones.greatGatsby",
    authorKey: "achievements.authors.fitzgerald",
  },
  {
    words: 75_000,
    titleKey: "achievements.milestones.frankenstein",
    authorKey: "achievements.authors.shelley",
  },
  {
    words: 100_000,
    titleKey: "achievements.milestones.prideAndPrejudice",
    authorKey: "achievements.authors.austen",
  },
  {
    words: 135_000,
    titleKey: "achievements.milestones.nineteenEightyFour",
    authorKey: "achievements.authors.orwell",
  },
  {
    words: 210_000,
    titleKey: "achievements.milestones.mobyDick",
    authorKey: "achievements.authors.melville",
  },
  {
    words: 250_000,
    titleKey: "achievements.milestones.englishDictionary",
    authorKey: null,
  },
  {
    words: 418_000,
    titleKey: "achievements.milestones.ulysses",
    authorKey: "achievements.authors.joyce",
  },
  {
    words: 587_000,
    titleKey: "achievements.milestones.warAndPeace",
    authorKey: "achievements.authors.tolstoy",
  },
  {
    words: 1_084_000,
    titleKey: "achievements.milestones.shakespeareComplete",
    authorKey: null,
  },
] as const;

export interface MilestoneProgress {
  readonly current: LiteraryMilestone | null;
  readonly next: LiteraryMilestone | null;
  readonly wordsIntoCurrent: number;
  readonly wordsToNext: number;
  readonly progressRatio: number;
}

/**
 * Given a lifetime word count, determine the user's current milestone tier
 * and progress toward the next one. Returns a fully-populated shape so the
 * UI never has to special-case "no milestones reached yet".
 */
export function computeMilestoneProgress(
  totalWords: number,
): MilestoneProgress {
  const words = Math.max(0, Math.floor(totalWords));
  let currentIndex = -1;
  for (let i = 0; i < LITERARY_MILESTONES.length; i += 1) {
    if (words >= LITERARY_MILESTONES[i].words) {
      currentIndex = i;
    } else {
      break;
    }
  }

  const current = currentIndex >= 0 ? LITERARY_MILESTONES[currentIndex] : null;
  const next =
    currentIndex + 1 < LITERARY_MILESTONES.length
      ? LITERARY_MILESTONES[currentIndex + 1]
      : null;

  if (next === null) {
    return {
      current,
      next: null,
      wordsIntoCurrent: current === null ? words : words - current.words,
      wordsToNext: 0,
      progressRatio: 1,
    };
  }

  const floor = current?.words ?? 0;
  const span = next.words - floor;
  const into = words - floor;
  return {
    current,
    next,
    wordsIntoCurrent: into,
    wordsToNext: next.words - words,
    progressRatio: span > 0 ? Math.min(1, Math.max(0, into / span)) : 0,
  };
}
