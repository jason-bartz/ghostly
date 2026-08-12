import { describe, expect, it } from "vitest";
import type { MeetingSegment } from "@/bindings";
import { blockText, groupIntoBlocks } from "./meetingBlocks";

/**
 * The grouping rules have to agree with the backend's, because the refiner
 * corrects a block as a unit and the panel renders one as a card: if they
 * disagree, the model repunctuates across a seam the user never sees, or the
 * user reads a paragraph the model never saw whole. The constants mirrored here
 * are `BLOCK_GAP_MS`, `MAX_BLOCK_SEGMENTS` and `MAX_BLOCK_CHARS` in
 * `src-tauri/src/meetings/refine.rs`.
 */

let nextId = 1;

function segment(
  text: string,
  startMs: number,
  endMs: number,
  lane: MeetingSegment["lane"] = "system",
): MeetingSegment {
  return {
    id: nextId++,
    meetingId: "mtg_test",
    speakerId: null,
    lane,
    startMs,
    endMs,
    text,
    labelSource: "lane_default",
    isCrosstalk: false,
  };
}

describe("groupIntoBlocks", () => {
  it("joins segments separated by a breath", () => {
    const blocks = groupIntoBlocks([
      segment("There's some work to be done,", 0, 2000),
      segment("and some ongoing conversations.", 2600, 4000),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0])).toBe(
      "There's some work to be done, and some ongoing conversations.",
    );
  });

  it("breaks at a real pause", () => {
    const blocks = groupIntoBlocks([
      segment("There's some work to be done.", 0, 2000),
      segment("Okay, anything else?", 4000, 5000),
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("breaks when the lane changes, however small the gap", () => {
    // As close to "somebody else started talking" as two-lane capture gets.
    const blocks = groupIntoBlocks([
      segment("So I kept the date as it was.", 0, 2000, "mic"),
      segment("Yeah, that makes sense.", 2100, 3000, "system"),
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("caps a monologue rather than growing one card without limit", () => {
    // Someone presenting never leaves a 1.2s gap, so only the cap ends this.
    const segments = Array.from({ length: 20 }, (_, index) =>
      segment("and another clause,", index * 500, index * 500 + 400),
    );
    const blocks = groupIntoBlocks(segments);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.segments.length).toBeLessThanOrEqual(8);
    }
  });

  it("caps on characters as well as count", () => {
    const long = "x".repeat(300);
    const blocks = groupIntoBlocks([
      segment(long, 0, 1000),
      segment(long, 1100, 2000),
      segment(long, 2100, 3000),
    ]);
    // 900 chars cannot fit under the 700-char ceiling.
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("drops segments the refiner emptied", () => {
    // A standalone filler chunk — "So." — corrected away to nothing.
    const blocks = groupIntoBlocks([
      segment("", 0, 500),
      segment("Anyways, I've got a whole write-up.", 600, 2000),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0])).toBe("Anyways, I've got a whole write-up.");
  });

  it("counts characters per block, not for the whole transcript", () => {
    // Regression: a running total that is never reset makes every block after
    // the first a single segment, silently shredding a long meeting into
    // one-line cards.
    const text = "a".repeat(400);
    const blocks = groupIntoBlocks([
      segment(text, 0, 1000),
      segment(text, 1100, 2000),
      // A real pause: this starts a fresh block, and a fresh character count.
      segment("short.", 5000, 5500),
      segment("also short.", 5600, 6000),
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[2].segments).toHaveLength(2);
  });

  it("keeps the first segment's id as a stable key", () => {
    const first = segment("One.", 0, 500);
    const blocks = groupIntoBlocks([first, segment("Two.", 600, 1000)]);
    expect(blocks[0].key).toBe(first.id);
    expect(blocks[0].startMs).toBe(0);
  });
});
