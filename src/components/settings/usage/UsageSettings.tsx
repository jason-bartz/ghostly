import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { commands, type UsageStats } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";

const POLL_INTERVAL_MS = 15_000;

export const UsageSettings: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await commands.getUsageStats();
    if (result.status === "ok") {
      setStats(result.data);
      setError(null);
    } else {
      setError(String(result.error));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  if (error !== null) {
    return (
      <div className="max-w-3xl w-full mx-auto space-y-6">
        <div className="px-4 py-3 text-sm text-mid-gray">
          {t("usage.loadError")}
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

  return <UsageContent stats={stats} />;
};

interface UsageContentProps {
  readonly stats: UsageStats;
}

const UsageContent: React.FC<UsageContentProps> = ({ stats }) => {
  const { t } = useTranslation();

  const pct = useMemo(() => {
    if (stats.weekly_limit_secs === 0) return 0;
    const raw = stats.seconds_used / stats.weekly_limit_secs;
    return Math.min(1, Math.max(0, raw));
  }, [stats.seconds_used, stats.weekly_limit_secs]);

  const resetsLabel = useMemo(
    () => formatResetsIn(stats.resets_at_unix, t),
    [stats.resets_at_unix, t],
  );

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <CurrentWeekCard stats={stats} pct={pct} resetsLabel={resetsLabel} />

      <SettingsGroup
        title={t("usage.history.title", {
          count: Math.max(stats.history.length, 1),
        })}
      >
        <HistoryList
          history={stats.history}
          limitSecs={stats.weekly_limit_secs}
        />
      </SettingsGroup>

      <SettingsGroup title={t("usage.lifetime.title")}>
        <div className="px-4 py-4 text-sm">
          {t("usage.lifetime.value", {
            value: formatDurationLong(stats.lifetime_seconds, t),
          })}
        </div>
      </SettingsGroup>
    </div>
  );
};

interface CurrentWeekCardProps {
  readonly stats: UsageStats;
  readonly pct: number;
  readonly resetsLabel: string;
}

const CurrentWeekCard: React.FC<CurrentWeekCardProps> = ({
  stats,
  pct,
  resetsLabel,
}) => {
  const { t } = useTranslation();
  const usedLabel = formatDurationShort(stats.seconds_used);
  const limitLabel = formatDurationShort(stats.weekly_limit_secs);

  const barColor = stats.is_over_limit
    ? "bg-red-500"
    : stats.is_at_warning
      ? "bg-amber-500"
      : "bg-logo-primary";

  return (
    <div className="bg-background border border-mid-gray/20 rounded-lg p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-xs font-medium text-mid-gray uppercase tracking-wide">
              {t("usage.thisWeek.title")}
            </p>
            {stats.is_pro && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-logo-primary/15 text-logo-primary">
                {t("usage.pro.badge")}
              </span>
            )}
          </div>
          <p className="text-3xl font-semibold tabular-nums mt-1">
            {stats.is_pro
              ? usedLabel
              : t("usage.thisWeek.usedOfLimit", {
                  used: usedLabel,
                  limit: limitLabel,
                })}
          </p>
        </div>
        <p className="text-sm text-mid-gray max-w-xs text-right">
          {stats.is_pro ? t("usage.pro.subtitle") : resetsLabel}
        </p>
      </div>

      {!stats.is_pro && (
        <div>
          <div className="h-2 w-full rounded-full bg-mid-gray/10 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
              style={{ width: `${Math.round(pct * 100)}%` }}
              aria-hidden
            />
          </div>
          {stats.is_over_limit && (
            <p className="mt-3 text-sm text-red-500">
              {t("usage.thisWeek.overLimit")}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

interface HistoryListProps {
  readonly history: UsageStats["history"];
  readonly limitSecs: number;
}

const HistoryList: React.FC<HistoryListProps> = ({ history, limitSecs }) => {
  const { t } = useTranslation();

  if (history.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-mid-gray text-center">
        {t("usage.history.empty")}
      </div>
    );
  }

  return (
    <div>
      {history.map((w) => {
        const pct = limitSecs === 0 ? 0 : Math.min(1, w.seconds / limitSecs);
        return (
          <div
            key={w.week_start_iso}
            className="px-4 py-3 flex items-center gap-4"
          >
            <div className="w-24 shrink-0 text-sm tabular-nums">
              {formatWeekLabel(w.week_start_iso)}
            </div>
            <div className="flex-1 h-1.5 rounded-full bg-mid-gray/10 overflow-hidden">
              <div
                className={`h-full rounded-full ${
                  w.hit_limit ? "bg-amber-500" : "bg-logo-primary"
                }`}
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
            <div className="w-28 shrink-0 text-right text-sm tabular-nums">
              {formatDurationShort(w.seconds)}
              {w.hit_limit && (
                <span className="ml-2 text-xs text-amber-500">
                  {t("usage.history.hitLimit")}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ---------- formatting ----------

function formatDurationShort(secs: number): string {
  const safe = Math.max(0, Math.floor(secs));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDurationLong(
  secs: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const safe = Math.max(0, Math.floor(secs));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m`;
  // translator param `t` reserved for future unit-localized formatting
}

function formatResetsIn(
  unix: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = unix - now;
  if (diff <= 0) return t("usage.thisWeek.resetsMonday");
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days === 0) parts.push(`${hours}h`);
  return t("usage.thisWeek.resetsIn", { time: parts.join(" ") });
}

function formatWeekLabel(iso: string): string {
  // Display as "Apr 13" — the Monday of that week.
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
