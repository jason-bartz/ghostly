import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "../../../bindings";
import type { MeetingSegment } from "../../../bindings";
import { groupIntoBlocks } from "@/lib/meetingBlocks";

/**
 * The editable transcript inside an expanded library row.
 *
 * Speech recognition gets names and jargon wrong, and AI cleanup narrows that
 * without closing it. A transcript people export and send on needs the last few
 * errors fixable by hand — which is all this is now.
 *
 * It used to be more. There was a speaker roster across the top with rename and
 * "Merge into…" controls, an "Add speaker" button, and a dropdown on every
 * single line for reassigning it to someone else. All of it was machinery for
 * correcting an attribution that Ghostly was never in a position to make:
 * without a speaker-embedding model, "You" and "Participant" only ever meant
 * "arrived on the microphone lane" and "arrived on the system lane". Two people
 * sharing a laptop were one speaker; the user's own voice echoing back off the
 * call was a second. Asking the user to hand-repair that on a per-line dropdown
 * was asking them to do the product's job.
 *
 * So the transcript reads as paragraphs and claims nothing about who spoke.
 * Editing is per *segment* — the row that actually exists in the database — but
 * the segments of one block are laid out as a single paragraph, so what you
 * click is the sentence you meant to fix.
 *
 * Every edit is applied to local state first and reconciled on failure. These
 * are single-row SQLite writes, but they still cross an IPC boundary, and a
 * line that visibly reverts for a frame while you are proofreading reads as a
 * lost edit.
 */

interface Props {
  segments: MeetingSegment[];
  onChange: (next: { segments: MeetingSegment[] }) => void;
}

export const MeetingTranscriptEditor: React.FC<Props> = ({
  segments,
  onChange,
}) => {
  const { t } = useTranslation();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [textDraft, setTextDraft] = useState("");

  // Where the pointer went down, so a click that was really a drag can be told
  // apart from a click that was really a click. See `beganWithADrag`.
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  const blocks = useMemo(() => groupIntoBlocks(segments), [segments]);

  /**
   * Whether the click that just landed was the end of a drag.
   *
   * Every line is a button so it can be reached from the keyboard, and a
   * button swallows the gesture that selects text — so dragging across the
   * transcript to copy a quote opened an editor instead. Comparing where the
   * pointer went down with where it came up separates the two: a click that
   * moved is a selection and is left alone, a click that did not is an edit.
   */
  const beganWithADrag = (event: React.MouseEvent) => {
    const origin = pressOrigin.current;
    pressOrigin.current = null;
    if (!origin) return false;
    return Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4;
  };

  const commitText = async (segment: MeetingSegment) => {
    const next = textDraft.trim();
    setEditingId(null);
    if (!next || next === segment.text) return;

    onChange({
      segments: segments.map((s) =>
        s.id === segment.id ? { ...s, text: next } : s,
      ),
    });
    const result = await commands.setMeetingSegmentText(segment.id, next);
    if (result.status === "error") {
      toast.error(result.error);
      onChange({ segments });
    }
  };

  return (
    <div className="max-h-72 overflow-y-auto pr-1">
      {blocks.map((block) => (
        // One card per block, matching the live panel. `inline` on the buttons
        // is what makes several segments read as continuous prose inside the
        // card rather than as a stack of one-line blocks, while each stays
        // separately clickable — the segment is still the row being edited.
        <p
          key={block.key}
          className="mb-1.5 w-fit max-w-full rounded-[13px] bg-fill-1 px-3 py-2 text-[12px] leading-[1.6] text-text-muted last:mb-0"
        >
          {block.segments.map((segment) =>
            editingId === segment.id ? (
              <textarea
                key={segment.id}
                autoFocus
                rows={2}
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                onBlur={() => void commitText(segment)}
                onKeyDown={(e) => {
                  // Enter saves; Shift+Enter is a newline, because a
                  // transcript line occasionally needs one.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void commitText(segment);
                  }
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="my-1 block w-full resize-y rounded border border-hairline-strong bg-surface-2 px-1 py-[1px] text-[12px] leading-snug outline-none"
              />
            ) : (
              <button
                key={segment.id}
                type="button"
                onPointerDown={(event) => {
                  pressOrigin.current = { x: event.clientX, y: event.clientY };
                }}
                onClick={(event) => {
                  if (beganWithADrag(event)) return;
                  setEditingId(segment.id);
                  setTextDraft(segment.text);
                }}
                title={t("meeting.library.editLine")}
                className="inline cursor-text select-text rounded px-[2px] text-left hover:bg-fill-1 hover:text-text"
              >
                {segment.text}
              </button>
            ),
          )}
        </p>
      ))}
    </div>
  );
};
