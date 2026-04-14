import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  Clock3,
  Coffee,
  FileText,
  Flag,
  Footprints,
  Gauge,
  Library,
  Milestone,
  Moon,
  PenLine,
  Repeat,
  ScrollText,
  Sparkles,
  Star,
  Sunrise,
  Telescope,
  Trophy,
} from "lucide-react";
import type { BadgeId } from "@/bindings";

/**
 * A displayable badge definition. The `id` is typed as the specta-exported
 * `BadgeId` union so adding a variant on the Rust side without registering a
 * display entry here fails the TypeScript build immediately, preventing the
 * badge wall from silently dropping an unknown badge.
 */
export interface BadgeDefinition {
  readonly id: BadgeId;
  readonly icon: LucideIcon;
  readonly titleKey: string;
  readonly descriptionKey: string;
}

/**
 * Exhaustive map from every `BadgeId` to its display metadata.
 *
 * The `Record<BadgeId, ...>` signature makes this table exhaustiveness-checked
 * at compile time: adding a variant to the Rust `BadgeId` enum without adding
 * a corresponding entry here is a TypeScript error, not a silent UI gap.
 */
const BADGES_BY_ID: Record<BadgeId, Omit<BadgeDefinition, "id">> = {
  first_words: {
    icon: Sparkles,
    titleKey: "achievements.badges.firstWords.title",
    descriptionKey: "achievements.badges.firstWords.description",
  },
  getting_started: {
    icon: Footprints,
    titleKey: "achievements.badges.gettingStarted.title",
    descriptionKey: "achievements.badges.gettingStarted.description",
  },
  regular: {
    icon: Repeat,
    titleKey: "achievements.badges.regular.title",
    descriptionKey: "achievements.badges.regular.description",
  },
  devoted: {
    icon: Star,
    titleKey: "achievements.badges.devoted.title",
    descriptionKey: "achievements.badges.devoted.description",
  },
  paragraph: {
    icon: FileText,
    titleKey: "achievements.badges.paragraph.title",
    descriptionKey: "achievements.badges.paragraph.description",
  },
  marathon: {
    icon: ScrollText,
    titleKey: "achievements.badges.marathon.title",
    descriptionKey: "achievements.badges.marathon.description",
  },
  one_hour_club: {
    icon: Clock3,
    titleKey: "achievements.badges.oneHourClub.title",
    descriptionKey: "achievements.badges.oneHourClub.description",
  },
  ten_hour_club: {
    icon: Gauge,
    titleKey: "achievements.badges.tenHourClub.title",
    descriptionKey: "achievements.badges.tenHourClub.description",
  },
  post_processor: {
    icon: PenLine,
    titleKey: "achievements.badges.postProcessor.title",
    descriptionKey: "achievements.badges.postProcessor.description",
  },
  collector: {
    icon: Library,
    titleKey: "achievements.badges.collector.title",
    descriptionKey: "achievements.badges.collector.description",
  },
  lexicographer: {
    icon: BookOpenText,
    titleKey: "achievements.badges.lexicographer.title",
    descriptionKey: "achievements.badges.lexicographer.description",
  },
  early_bird: {
    icon: Sunrise,
    titleKey: "achievements.badges.earlyBird.title",
    descriptionKey: "achievements.badges.earlyBird.description",
  },
  night_owl: {
    icon: Moon,
    titleKey: "achievements.badges.nightOwl.title",
    descriptionKey: "achievements.badges.nightOwl.description",
  },
  lunch_break: {
    icon: Coffee,
    titleKey: "achievements.badges.lunchBreak.title",
    descriptionKey: "achievements.badges.lunchBreak.description",
  },
  every_day_of_the_week: {
    icon: Flag,
    titleKey: "achievements.badges.everyDayOfTheWeek.title",
    descriptionKey: "achievements.badges.everyDayOfTheWeek.description",
  },
  sprint: {
    icon: Telescope,
    titleKey: "achievements.badges.sprint.title",
    descriptionKey: "achievements.badges.sprint.description",
  },
  questioner: {
    icon: Milestone,
    titleKey: "achievements.badges.questioner.title",
    descriptionKey: "achievements.badges.questioner.description",
  },
  exclaimer: {
    icon: Trophy,
    titleKey: "achievements.badges.exclaimer.title",
    descriptionKey: "achievements.badges.exclaimer.description",
  },
};

/**
 * Render order on the badge wall: onboarding wins first, steady-state
 * achievements in the middle, long-horizon goals last. Pulled from
 * `BADGES_BY_ID` so the exhaustive compile-time check remains the source
 * of truth; changing this array to add or reorder items cannot lose a badge.
 */
const DISPLAY_ORDER: readonly BadgeId[] = [
  "first_words",
  "getting_started",
  "regular",
  "devoted",
  "paragraph",
  "marathon",
  "one_hour_club",
  "ten_hour_club",
  "post_processor",
  "collector",
  "lexicographer",
  "early_bird",
  "night_owl",
  "lunch_break",
  "every_day_of_the_week",
  "sprint",
  "questioner",
  "exclaimer",
];

export const BADGES: readonly BadgeDefinition[] = DISPLAY_ORDER.map((id) => ({
  id,
  ...BADGES_BY_ID[id],
}));
