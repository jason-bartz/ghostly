import type { MeetingSegment } from "@/bindings";

/**
 * Transcript segments, grouped the way they are read.
 *
 * A meeting transcript is not a chat log. It used to be rendered as one, with
 * every utterance stamped and attributed to "You" or "Participant" — labels
 * that were never better than a guess, because Ghostly ships no
 * speaker-embedding model and "which lane did the audio arrive on" is all it
 * ever knew. Two people on one microphone were one speaker; the user's own
 * voice echoing back off the call was a second one.
 *
 * So the names are gone, and what is left is the shape underneath them:
 * paragraphs. A block is one continuous stretch of speech, broken where the
 * speaker actually stopped — which is the same rule the backend's segmenter and
 * refinement pass use, so what is corrected together is what is displayed
 * together.
 */
export interface TranscriptBlock {
  /** Stable across re-renders: the id of the block's first segment. */
  key: number;
  segments: MeetingSegment[];
  /** Milliseconds from the start of capture, for the hover timestamp. */
  startMs: number;
}

/**
 * Silence that ends a paragraph.
 *
 * Mirrors `BLOCK_GAP_MS` in `src-tauri/src/meetings/refine.rs` and
 * `PARAGRAPH_GAP_MS` in `summarizer.rs`. Above the segmenter's own 900 ms
 * silence threshold, so a segment that closed on a breath is joined to the one
 * that follows it rather than being stranded as its own paragraph.
 */
const BLOCK_GAP_MS = 1200;

/**
 * Caps on how much speech one card may hold, mirroring `MAX_BLOCK_SEGMENTS`
 * and `MAX_BLOCK_CHARS` in `src-tauri/src/meetings/refine.rs`.
 *
 * Without them a speaker who never leaves a 1.2s gap — anyone presenting —
 * renders as a single card that grows without limit, while the refiner has
 * quietly been splitting the same speech into blocks of eight all along. Same
 * numbers on both sides, so what is corrected together is what is shown
 * together.
 */
const MAX_BLOCK_SEGMENTS = 8;
const MAX_BLOCK_CHARS = 700;

/**
 * Groups segments into paragraphs.
 *
 * A new block begins when the audio lane changes — which is as close to "a
 * different person started talking" as the two-lane capture can get — or when
 * the gap since the previous segment is long enough to be a real pause rather
 * than a breath.
 *
 * Segments the refinement pass emptied are dropped: those were standalone
 * filler ("So.", "Um, yeah") that only existed because the VAD closed on a
 * hesitation.
 */
export function groupIntoBlocks(segments: MeetingSegment[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let chars = 0;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;

    const last = blocks[blocks.length - 1];
    const previous = last?.segments[last.segments.length - 1];
    const continues =
      last !== undefined &&
      previous !== undefined &&
      previous.lane === segment.lane &&
      Number(segment.startMs) - Number(previous.endMs) < BLOCK_GAP_MS &&
      last.segments.length < MAX_BLOCK_SEGMENTS &&
      chars + text.length <= MAX_BLOCK_CHARS;

    if (continues && last) {
      last.segments.push(segment);
      chars += text.length;
    } else {
      blocks.push({
        key: segment.id,
        segments: [segment],
        startMs: Number(segment.startMs),
      });
      chars = text.length;
    }
  }

  return blocks;
}

/** A block as one paragraph of prose. */
export function blockText(block: TranscriptBlock): string {
  return block.segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ");
}
