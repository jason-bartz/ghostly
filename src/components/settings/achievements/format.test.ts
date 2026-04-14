import { describe, expect, it } from "vitest";
import { formatCount, formatDuration } from "./format";

/**
 * Minimal stand-in for the `t` function that `formatDuration` expects. It
 * reproduces i18next's `_one`/`_other` suffix selection against an English
 * plural rule so the tests stay independent of the real i18n runtime.
 */
function makeT() {
  return (key: string, options?: Record<string, unknown>): string => {
    const count =
      typeof options?.count === "number" ? options.count : undefined;
    const resolvedKey =
      count === undefined ? key : `${key}_${count === 1 ? "one" : "other"}`;
    const params = options ?? {};
    const bits = Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",");
    return bits.length > 0 ? `${resolvedKey}(${bits})` : resolvedKey;
  };
}

describe("formatCount", () => {
  it("formats whole numbers with locale separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1_234, "en-US")).toBe("1,234");
    expect(formatCount(1_000_000, "en-US")).toBe("1,000,000");
  });

  it("clamps negatives and floors fractional values to avoid misleading totals", () => {
    expect(formatCount(-42)).toBe("0");
    expect(formatCount(1_234.9, "en-US")).toBe("1,234");
  });

  it("falls back gracefully on an unsupported locale tag", () => {
    // Invalid BCP-47 tag — Intl throws RangeError; we expect the fallback.
    expect(formatCount(42, "not-a-real-locale")).toBe("42");
  });
});

describe("formatDuration", () => {
  const t = makeT();

  it("reports whole seconds for sub-minute durations", () => {
    expect(formatDuration(0, t)).toBe(
      "achievements.duration.seconds_other(count=0)",
    );
    expect(formatDuration(1_000, t)).toBe(
      "achievements.duration.seconds_one(count=1)",
    );
    expect(formatDuration(59_999, t)).toBe(
      "achievements.duration.seconds_other(count=59)",
    );
  });

  it("switches to minutes at exactly one minute and stays there below one hour", () => {
    expect(formatDuration(60_000, t)).toBe(
      "achievements.duration.minutes_one(count=1)",
    );
    expect(formatDuration(30 * 60_000, t)).toBe(
      "achievements.duration.minutes_other(count=30)",
    );
  });

  it("uses bare 'hours' copy when minutes are zero", () => {
    expect(formatDuration(60 * 60_000, t)).toBe(
      "achievements.duration.hours_one(count=1)",
    );
    expect(formatDuration(5 * 60 * 60_000, t)).toBe(
      "achievements.duration.hours_other(count=5)",
    );
  });

  it("uses combined hours+minutes copy when both are present", () => {
    expect(formatDuration((2 * 60 + 37) * 60_000, t)).toBe(
      "achievements.duration.hoursMinutes(hours=2,minutes=37)",
    );
  });

  it("uses days once the duration crosses 24 hours", () => {
    expect(formatDuration(24 * 60 * 60_000, t)).toBe(
      "achievements.duration.days_one(count=1)",
    );
    expect(formatDuration(3 * 24 * 60 * 60_000 + 5 * 60 * 60_000, t)).toBe(
      "achievements.duration.daysHours(days=3,hours=5)",
    );
  });

  it("treats negative, NaN, and Infinity inputs as zero rather than crashing", () => {
    expect(formatDuration(-1, t)).toBe(
      "achievements.duration.seconds_other(count=0)",
    );
    expect(formatDuration(Number.NaN, t)).toBe(
      "achievements.duration.seconds_other(count=0)",
    );
    expect(formatDuration(Number.POSITIVE_INFINITY, t)).toBe(
      "achievements.duration.seconds_other(count=0)",
    );
  });
});
