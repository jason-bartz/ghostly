import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Lock, BookOpen } from "lucide-react";
import {
  commands,
  events,
  type BadgeId,
  type EarnedBadge,
  type TranscriptionStats,
} from "@/bindings";

const STATS_REFRESH_DEBOUNCE_MS = 300;

/** Badges unlocked within this window (ms) show a "New" tag. */
const NEW_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

import { BADGES } from "./badges";
import { computeMilestoneProgress, LITERARY_MILESTONES } from "./milestones";
import { formatCount, formatDuration } from "./format";

export const AchievementsSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [stats, setStats] = useState<TranscriptionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const debounceHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStats = useCallback(async () => {
    const result = await commands.getTranscriptionStats();
    if (!mountedRef.current) return;
    if (result.status === "ok") {
      setStats(result.data);
      setError(null);
    } else {
      setError(String(result.error));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadStats();

    const scheduleReload = () => {
      if (debounceHandleRef.current !== null) {
        clearTimeout(debounceHandleRef.current);
      }
      debounceHandleRef.current = setTimeout(() => {
        debounceHandleRef.current = null;
        void loadStats();
      }, STATS_REFRESH_DEBOUNCE_MS);
    };

    const unlisten = events.historyUpdatePayload.listen(scheduleReload);

    return () => {
      mountedRef.current = false;
      if (debounceHandleRef.current !== null) {
        clearTimeout(debounceHandleRef.current);
        debounceHandleRef.current = null;
      }
      void unlisten.then((fn) => fn());
    };
  }, [loadStats]);

  if (error !== null) {
    return (
      <div className="max-w-3xl w-full mx-auto space-y-6">
        <div className="px-4 py-3 text-sm text-text-muted">
          {t("achievements.loadError")}
        </div>
      </div>
    );
  }

  if (stats === null) {
    return (
      <div className="max-w-3xl w-full mx-auto flex items-center justify-center py-12 text-accent-bright">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return <AchievementsContent stats={stats} locale={i18n.language} />;
};

interface AchievementsContentProps {
  readonly stats: TranscriptionStats;
  readonly locale: string;
}

const AchievementsContent: React.FC<AchievementsContentProps> = ({
  stats,
  locale,
}) => {
  const { t } = useTranslation();
  const earnedMap = useMemo<ReadonlyMap<BadgeId, EarnedBadge>>(
    () => new Map(stats.earned_badges.map((b) => [b.id, b])),
    [stats.earned_badges],
  );
  const empty = stats.transcription_count === 0;
  const earnedCount = stats.earned_badges.length;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5 pb-6">
      <LiteraryLadderCard totalWords={stats.total_words} locale={locale} />

      <StatsGrid stats={stats} locale={locale} />

      <div className="space-y-3">
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-[10px] font-semibold text-text-faint uppercase tracking-[0.08em]">
            {t("achievements.badges.title")}
          </h2>
          {!empty && (
            <span className="text-[11px] tabular-nums font-mono text-text-muted">
              {earnedCount}/{BADGES.length}
            </span>
          )}
        </div>
        <BadgeWall earnedMap={earnedMap} empty={empty} locale={locale} />
      </div>
    </div>
  );
};

interface LiteraryLadderCardProps {
  readonly totalWords: number;
  readonly locale: string;
}

const LiteraryLadderCard: React.FC<LiteraryLadderCardProps> = ({
  totalWords,
  locale,
}) => {
  const { t } = useTranslation();
  const progress = useMemo(
    () => computeMilestoneProgress(totalWords),
    [totalWords],
  );

  const nextTitle = progress.next
    ? t(progress.next.titleKey)
    : t(LITERARY_MILESTONES[LITERARY_MILESTONES.length - 1].titleKey);
  const currentLabel = progress.current
    ? t("achievements.ladder.currentTier", {
        title: t(progress.current.titleKey),
      })
    : t("achievements.ladder.notYetReached");
  const supportingText = progress.next
    ? t("achievements.ladder.toNext", {
        words: formatCount(progress.wordsToNext, locale),
        title: nextTitle,
      })
    : t("achievements.ladder.maxReached", { title: nextTitle });

  const percent = Math.round(progress.progressRatio * 100);
  const progressAriaLabel = t("achievements.ladder.progressLabel", {
    title: nextTitle,
  });
  const progressAriaValueText = progress.next
    ? t("achievements.ladder.progressValueText", {
        percent,
        title: nextTitle,
      })
    : t("achievements.ladder.progressValueTextMax", { title: nextTitle });

  return (
    <section
      aria-label={t("achievements.ladder.totalWords")}
      className="relative overflow-hidden surface-card-raised rounded-2xl p-5 space-y-4"
    >
      {/* Decorative accent */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent opacity-80" />
      <div
        aria-hidden
        className="absolute -top-20 -right-16 w-56 h-56 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(167, 139, 250, 0.18) 0%, transparent 60%)",
          filter: "blur(20px)",
        }}
      />

      <div className="relative flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 w-11 h-11 rounded-xl bg-accent/12 border border-accent/25 flex items-center justify-center shrink-0">
            <BookOpen
              className="w-5 h-5 text-accent-bright"
              strokeWidth={1.75}
            />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-text-faint uppercase tracking-[0.08em]">
              {t("achievements.ladder.totalWords")}
            </p>
            <p className="text-3xl font-display tabular-nums tracking-tight text-text">
              {formatCount(totalWords, locale)}
            </p>
          </div>
        </div>
        <p className="text-[12.5px] text-text-muted max-w-[11rem] text-right leading-snug mt-1">
          {currentLabel}
        </p>
      </div>

      <div className="relative">
        <div
          role="progressbar"
          aria-label={progressAriaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={progressAriaValueText}
          className="h-2 w-full rounded-full bg-white/[0.06] overflow-hidden"
        >
          <div
            className="h-full bg-gradient-to-r from-accent to-accent-deep rounded-full transition-all duration-700 ease-out shadow-[0_0_12px_rgba(167,139,250,0.5)]"
            style={{ width: `${percent}%` }}
            aria-hidden
          />
        </div>
        <p className="mt-2 text-[12.5px] text-text-muted">{supportingText}</p>
      </div>
    </section>
  );
};

interface StatsGridProps {
  readonly stats: TranscriptionStats;
  readonly locale: string;
}

const StatsGrid: React.FC<StatsGridProps> = ({ stats, locale }) => {
  const { t } = useTranslation();
  const tiles: readonly {
    labelKey: string;
    value: string;
  }[] = [
    {
      labelKey: "achievements.stats.transcriptions",
      value: formatCount(stats.transcription_count, locale),
    },
    {
      labelKey: "achievements.stats.audio",
      value: formatDuration(stats.total_duration_ms, t),
    },
    {
      labelKey: "achievements.stats.longest",
      value: t("achievements.stats.wordsValue", {
        count: stats.longest_transcription_words,
        value: formatCount(stats.longest_transcription_words, locale),
      }),
    },
    {
      labelKey: "achievements.stats.words",
      value: formatCount(stats.total_words, locale),
    },
  ];

  return (
    <dl
      aria-label={t("achievements.stats.title")}
      className="grid grid-cols-2 gap-2.5"
    >
      {tiles.map((tile) => (
        <div
          key={tile.labelKey}
          className="surface-card rounded-xl px-4 py-4 text-center"
        >
          <dd className="text-2xl font-display tabular-nums leading-none tracking-tight text-text">
            {tile.value}
          </dd>
          <dt className="mt-2 text-[10px] font-semibold text-text-faint uppercase tracking-[0.08em]">
            {t(tile.labelKey)}
          </dt>
        </div>
      ))}
    </dl>
  );
};

/** Format a unix timestamp (seconds) as a short localized date. */
function formatUnlockDate(ts: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(ts * 1000));
  } catch {
    return new Date(ts * 1000).toLocaleDateString();
  }
}

/** True if the badge was unlocked within the last `NEW_BADGE_WINDOW_MS`. */
function isNewBadge(unlockedAt: number): boolean {
  return Date.now() - unlockedAt * 1000 < NEW_BADGE_WINDOW_MS;
}

interface BadgeWallProps {
  readonly earnedMap: ReadonlyMap<BadgeId, EarnedBadge>;
  readonly empty: boolean;
  readonly locale: string;
}

const BadgeWall: React.FC<BadgeWallProps> = ({ earnedMap, empty, locale }) => {
  const { t } = useTranslation();

  // Sort: earned badges first (newest first), then locked
  const sorted = useMemo(() => {
    const earnedBadges = BADGES.filter((b) => earnedMap.has(b.id));
    // Sort earned by unlock date descending (most recent first)
    earnedBadges.sort((a, b) => {
      const aTime = earnedMap.get(a.id)?.unlocked_at ?? 0;
      const bTime = earnedMap.get(b.id)?.unlocked_at ?? 0;
      return bTime - aTime;
    });
    const lockedBadges = BADGES.filter((b) => !earnedMap.has(b.id));
    return [...earnedBadges, ...lockedBadges];
  }, [earnedMap]);

  if (empty) {
    return (
      <div className="px-4 py-8 text-sm text-text-muted text-center surface-card rounded-xl">
        {t("achievements.badges.emptyState")}
      </div>
    );
  }

  return (
    <ul
      role="list"
      aria-label={t("achievements.badges.title")}
      className="grid grid-cols-1 sm:grid-cols-2 gap-2.5"
    >
      {sorted.map((badge) => {
        const earnedBadge = earnedMap.get(badge.id);
        const earned = earnedBadge != null;
        const isNew = earned && isNewBadge(earnedBadge.unlocked_at);
        const Icon = earned ? badge.icon : Lock;
        const title = t(badge.titleKey);
        const description = t(badge.descriptionKey);
        const statusLabel = earned
          ? t("achievements.badges.status.earned")
          : t("achievements.badges.status.locked");
        return (
          <li
            key={badge.id}
            role="listitem"
            aria-label={`${title}, ${statusLabel}`}
            className={`relative flex items-start gap-3 px-4 py-3.5 rounded-xl border transition-all duration-200 overflow-hidden ${
              earned
                ? "border-accent/30 bg-gradient-to-br from-accent/[0.08] via-accent/[0.03] to-transparent hover:border-accent/50 hover:from-accent/[0.12] shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_16px_36px_-20px_rgba(124,58,237,0.55)]"
                : "border-hairline bg-white/[0.02]"
            }`}
          >
            {earned && (
              <div
                aria-hidden
                className="absolute -top-10 -right-10 w-28 h-28 rounded-full pointer-events-none"
                style={{
                  background:
                    "radial-gradient(circle, rgba(167, 139, 250, 0.18) 0%, transparent 60%)",
                  filter: "blur(14px)",
                }}
              />
            )}
            <div
              className={`relative shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
                earned
                  ? "bg-accent/15 border border-accent/30 text-accent-bright shadow-[0_0_14px_rgba(167,139,250,0.3)]"
                  : "bg-white/[0.03] border border-hairline text-text-faint"
              }`}
              aria-hidden
            >
              <Icon width={18} height={18} strokeWidth={1.75} />
            </div>
            <div className="relative min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p
                  className={`text-[13.5px] font-semibold truncate ${
                    earned ? "text-text" : "text-text-muted"
                  }`}
                >
                  {title}
                </p>
                {isNew && (
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.08em] bg-accent/20 text-accent-bright border border-accent/40 px-1.5 py-0.5 rounded-full">
                    {t("achievements.badges.new")}
                  </span>
                )}
              </div>
              <p
                className={`text-[12px] mt-1 leading-snug ${
                  earned ? "text-text-muted" : "text-text-subtle"
                }`}
              >
                {earned
                  ? description
                  : t("achievements.badges.lockedDescription", { description })}
              </p>
              {earned && (
                <p className="text-[10.5px] font-mono tabular-nums text-accent-bright/80 mt-1.5">
                  {t("achievements.badges.unlocked", {
                    date: formatUnlockDate(earnedBadge.unlocked_at, locale),
                  })}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};
