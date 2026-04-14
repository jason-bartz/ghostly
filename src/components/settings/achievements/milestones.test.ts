import { describe, expect, it } from "vitest";
import { LITERARY_MILESTONES, computeMilestoneProgress } from "./milestones";

describe("computeMilestoneProgress", () => {
  it("returns null current and the first milestone as next for a fresh account", () => {
    const result = computeMilestoneProgress(0);
    expect(result.current).toBeNull();
    expect(result.next).toBe(LITERARY_MILESTONES[0]);
    expect(result.wordsIntoCurrent).toBe(0);
    expect(result.wordsToNext).toBe(LITERARY_MILESTONES[0].words);
    expect(result.progressRatio).toBe(0);
  });

  it("treats hitting a milestone threshold exactly as having just entered that tier", () => {
    const threshold = LITERARY_MILESTONES[0].words;
    const result = computeMilestoneProgress(threshold);
    expect(result.current).toBe(LITERARY_MILESTONES[0]);
    expect(result.next).toBe(LITERARY_MILESTONES[1]);
    expect(result.wordsIntoCurrent).toBe(0);
  });

  it("reports proportional progress halfway between two tiers", () => {
    const lower = LITERARY_MILESTONES[0].words;
    const upper = LITERARY_MILESTONES[1].words;
    const midpoint = lower + Math.floor((upper - lower) / 2);
    const result = computeMilestoneProgress(midpoint);
    expect(result.current).toBe(LITERARY_MILESTONES[0]);
    expect(result.next).toBe(LITERARY_MILESTONES[1]);
    expect(result.progressRatio).toBeGreaterThan(0.49);
    expect(result.progressRatio).toBeLessThan(0.51);
    expect(result.wordsToNext).toBe(upper - midpoint);
  });

  it("saturates at the final tier with progressRatio=1 and no next tier", () => {
    const last = LITERARY_MILESTONES[LITERARY_MILESTONES.length - 1];
    const result = computeMilestoneProgress(last.words + 1_000_000);
    expect(result.current).toBe(last);
    expect(result.next).toBeNull();
    expect(result.progressRatio).toBe(1);
    expect(result.wordsToNext).toBe(0);
  });

  it("clamps negative and non-integer inputs to valid values", () => {
    const negative = computeMilestoneProgress(-5_000);
    expect(negative.current).toBeNull();
    expect(negative.next).toBe(LITERARY_MILESTONES[0]);
    expect(negative.wordsToNext).toBe(LITERARY_MILESTONES[0].words);

    const fractional = computeMilestoneProgress(
      LITERARY_MILESTONES[0].words + 0.9,
    );
    // Fractional portion is floored, so we sit exactly on the threshold.
    expect(fractional.current).toBe(LITERARY_MILESTONES[0]);
    expect(fractional.wordsIntoCurrent).toBe(0);
  });

  it("milestones remain strictly increasing (invariant the ladder UI depends on)", () => {
    for (let i = 1; i < LITERARY_MILESTONES.length; i += 1) {
      expect(LITERARY_MILESTONES[i].words).toBeGreaterThan(
        LITERARY_MILESTONES[i - 1].words,
      );
    }
  });
});
