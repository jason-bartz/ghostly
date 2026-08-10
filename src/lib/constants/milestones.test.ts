import { describe, expect, it } from "vitest";

import {
  MILESTONES,
  currentMilestone,
  milestoneProgress,
  nextMilestone,
} from "./milestones";

describe("MILESTONES", () => {
  it("is sorted ascending with no duplicate thresholds", () => {
    const words = MILESTONES.map((m) => m.words);
    expect(words).toEqual([...words].sort((a, b) => a - b));
    expect(new Set(words).size).toBe(words.length);
  });

  it("has no gap wide enough to stall a user for long", () => {
    // Below a million words, each milestone should be reachable from the one
    // before it without more than doubling the running total — otherwise the
    // sidebar sits on the same comparison for months.
    for (let i = 1; i < MILESTONES.length; i++) {
      const prev = MILESTONES[i - 1];
      const next = MILESTONES[i];
      if (prev.words > 1_000_000) continue;
      expect(
        next.words / prev.words,
        `${prev.title} → ${next.title}`,
      ).toBeLessThan(2);
    }
  });

  it("gives every entry a title and a positive threshold", () => {
    for (const milestone of MILESTONES) {
      expect(milestone.title.length).toBeGreaterThan(0);
      expect(milestone.words).toBeGreaterThan(0);
    }
  });
});

describe("currentMilestone", () => {
  it("returns nothing before the first threshold", () => {
    expect(currentMilestone(0)).toBeUndefined();
    expect(currentMilestone(MILESTONES[0].words - 1)).toBeUndefined();
  });

  it("returns the highest threshold reached", () => {
    expect(currentMilestone(MILESTONES[0].words)).toEqual(MILESTONES[0]);
    // 50,000 sits between The Prince (49,943) and The Jungle Book (50,839).
    expect(currentMilestone(50_000)?.title).toBe("The Prince");
    expect(currentMilestone(1_000_000_000)).toEqual(
      MILESTONES[MILESTONES.length - 1],
    );
  });
});

describe("nextMilestone", () => {
  it("returns the first threshold not yet reached", () => {
    expect(nextMilestone(0)).toEqual(MILESTONES[0]);
    expect(nextMilestone(MILESTONES[0].words)).toEqual(MILESTONES[1]);
  });

  it("returns nothing once the list is exhausted", () => {
    expect(
      nextMilestone(MILESTONES[MILESTONES.length - 1].words),
    ).toBeUndefined();
  });
});

describe("milestoneProgress", () => {
  it("measures the gap between the previous and next milestone", () => {
    const [first, second] = MILESTONES;
    expect(milestoneProgress(first.words)).toBe(0);
    expect(milestoneProgress((first.words + second.words) / 2)).toBeCloseTo(
      0.5,
    );
  });

  it("counts from zero before the first milestone", () => {
    expect(milestoneProgress(MILESTONES[0].words / 2)).toBeCloseTo(0.5);
  });

  it("is complete once every milestone is reached", () => {
    expect(milestoneProgress(1_000_000_000)).toBe(1);
  });
});
