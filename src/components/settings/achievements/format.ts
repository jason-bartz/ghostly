/**
 * Formatting helpers for the achievements surface. Kept separate from the
 * components so each can be unit-tested and reused without pulling React.
 */

/**
 * Format an integer count with locale-aware thousands separators.
 * Falls back to `toString()` if `Intl.NumberFormat` is unavailable.
 */
export function formatCount(value: number, locale?: string): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  try {
    return new Intl.NumberFormat(locale).format(safe);
  } catch {
    return safe.toString();
  }
}

/**
 * Format a duration in milliseconds as a compact, human-readable string.
 * Short durations show seconds, longer ones collapse to hours/minutes or
 * days/hours so the value always fits on one line without wrapping.
 */
export function formatDuration(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const totalSeconds = Math.floor(total / 1000);

  if (totalSeconds < 60) {
    return t("achievements.duration.seconds", { count: totalSeconds });
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return t("achievements.duration.minutes", { count: totalMinutes });
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0
      ? t("achievements.duration.hours", { count: hours })
      : t("achievements.duration.hoursMinutes", { hours, minutes });
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0
    ? t("achievements.duration.days", { count: days })
    : t("achievements.duration.daysHours", { days, hours: remHours });
}
