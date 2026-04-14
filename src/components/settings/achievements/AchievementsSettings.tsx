import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Lock } from "lucide-react";
import {
  commands,
  events,
  type BadgeId,
  type TranscriptionStats,
} from "@/bindings";

/**
 * Window in milliseconds during which back-to-back history-update events
 * collapse into a single stats refetch. Picked to feel instant to a human
 * (well below the 100ms perceptual bound) while coalescing the typical
 * burst that fires when a recording is saved, post-processed, and written
 * in quick succession.
 */
const STATS_REFRESH_DEBOUNCE_MS = 300;
import { SettingsGroup } from "../../ui/SettingsGroup";
import { BADGES } from "./badges";
import { computeMilestoneProgress, LITERARY_MILESTONES } from "./milestones";
import { formatCount, formatDuration } from "./format";

export const AchievementsSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [stats, setStats] = useState<TranscriptionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Flag for "the component is still mounted" so a late tauri event fired
  // after unmount doesn't invoke setState on an unmounted tree.
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
        <div className="px-4 py-3 text-sm text-mid-gray">
          {t("achievements.loadError")}
        </div>
      </div>
    );
  }

  if (stats === null) {
    return (
      <div className="max-w-3xl w-full mx-auto flex items-center justify-center py-12 text-mid-gray">
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
  const earned = useMemo<ReadonlySet<BadgeId>>(
    () => new Set(stats.earned_badge_ids),
    [stats.earned_badge_ids],
  );
  const empty = stats.transcription_count === 0;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <LiteraryLadderCard totalWords={stats.total_words} locale={locale} />

      <SettingsGroup title={t("achievements.stats.title")}>
        <StatsGrid stats={stats} locale={locale} />
      </SettingsGroup>

      <SettingsGroup
        title={t("achievements.badges.title")}
        description={t("achievements.badges.subtitle")}
      >
        <BadgeWall earnedIds={earned} empty={empty} />
      </SettingsGroup>
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
      className="bg-background border border-mid-gray/20 rounded-lg p-5 space-y-4"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t("achievements.ladder.totalWords")}
          </p>
          <p className="text-3xl font-semibold tabular-nums">
            {formatCount(totalWords, locale)}
          </p>
        </div>
        <p className="text-sm text-mid-gray max-w-xs text-right">
          {currentLabel}
        </p>
      </div>

      <div>
        <div
          role="progressbar"
          aria-label={progressAriaLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={progressAriaValueText}
          className="h-2 w-full rounded-full bg-mid-gray/10 overflow-hidden"
        >
          <div
            className="h-full bg-logo-primary rounded-full transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
            aria-hidden
          />
        </div>
        <p className="mt-2 text-sm text-mid-gray">{supportingText}</p>
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
      className="grid grid-cols-2 md:grid-cols-4 divide-x divide-mid-gray/20"
    >
      {tiles.map((tile) => (
        <div key={tile.labelKey} className="px-4 py-4 text-center">
          <dd className="text-2xl font-semibold tabular-nums leading-tight">
            {tile.value}
          </dd>
          <dt className="mt-1 text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t(tile.labelKey)}
          </dt>
        </div>
      ))}
    </dl>
  );
};

interface BadgeWallProps {
  readonly earnedIds: ReadonlySet<BadgeId>;
  readonly empty: boolean;
}

const BadgeWall: React.FC<BadgeWallProps> = ({ earnedIds, empty }) => {
  const { t } = useTranslation();

  if (empty) {
    return (
      <div className="px-4 py-6 text-sm text-mid-gray text-center">
        {t("achievements.badges.emptyState")}
      </div>
    );
  }

  return (
    <ul
      role="list"
      aria-label={t("achievements.badges.title")}
      className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-mid-gray/20"
    >
      {BADGES.map((badge) => {
        const earned = earnedIds.has(badge.id);
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
            className={`flex items-start gap-3 px-4 py-3 bg-background ${
              earned ? "" : "opacity-60"
            }`}
          >
            <div
              className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                earned
                  ? "bg-logo-primary/15 text-logo-primary"
                  : "bg-mid-gray/10 text-mid-gray"
              }`}
              aria-hidden
            >
              <Icon width={18} height={18} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{title}</p>
              <p className="text-xs text-mid-gray mt-0.5">
                {earned
                  ? description
                  : t("achievements.badges.lockedDescription", { description })}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
};
