import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { commands } from "../../../bindings";
import type { MeetingSegment, MeetingSpeaker } from "../../../bindings";

/**
 * The editable transcript inside an expanded library row.
 *
 * Speech recognition gets names, jargon and speaker boundaries wrong, and live
 * AI cleanup narrows that without closing it. A transcript people export and
 * send on needs the last few errors fixable by hand — which is what this is
 * for, and why the backend has long had `merge`, `reassign` and
 * `assign_segment_speaker` commands that nothing called.
 *
 * Every edit is applied to local state first and reconciled on failure. These
 * are single-row SQLite writes, but they still cross an IPC boundary, and a
 * line that visibly reverts for a frame while you are proofreading reads as a
 * lost edit.
 */

const SPEAKER_COLORS = [
  "var(--color-accent)",
  "var(--color-accent-alt)",
  "var(--color-accent-warm)",
  "var(--color-success)",
  "var(--color-warning)",
];

function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

interface Props {
  meetingId: string;
  segments: MeetingSegment[];
  speakers: MeetingSpeaker[];
  onChange: (next: {
    segments: MeetingSegment[];
    speakers: MeetingSpeaker[];
  }) => void;
}

export const MeetingTranscriptEditor: React.FC<Props> = ({
  meetingId,
  segments,
  speakers,
  onChange,
}) => {
  const { t } = useTranslation();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [addingSpeaker, setAddingSpeaker] = useState(false);
  const [newSpeakerDraft, setNewSpeakerDraft] = useState("");

  const speakerById = useMemo(() => {
    const map = new Map<string, MeetingSpeaker>();
    for (const speaker of speakers) map.set(speaker.id, speaker);
    return map;
  }, [speakers]);

  const nameFor = useCallback(
    (speaker: MeetingSpeaker | undefined, lane: MeetingSegment["lane"]) => {
      if (speaker?.displayName) return speaker.displayName;
      return lane === "mic"
        ? t("meeting.panel.you")
        : t("meeting.panel.participant");
    },
    [t],
  );

  const commitText = async (segment: MeetingSegment) => {
    const next = textDraft.trim();
    setEditingId(null);
    if (!next || next === segment.text) return;

    onChange({
      segments: segments.map((s) =>
        s.id === segment.id ? { ...s, text: next } : s,
      ),
      speakers,
    });
    const result = await commands.setMeetingSegmentText(segment.id, next);
    if (result.status === "error") {
      toast.error(result.error);
      onChange({ segments, speakers });
    }
  };

  const commitSpeakerName = async (speakerId: string) => {
    const next = nameDraft.trim();
    setRenamingSpeaker(null);
    if (!next) return;

    onChange({
      segments,
      speakers: speakers.map((s) =>
        s.id === speakerId ? { ...s, displayName: next, kind: "named" } : s,
      ),
    });
    const result = await commands.renameMeetingSpeaker(speakerId, next);
    if (result.status === "error") {
      toast.error(result.error);
      onChange({ segments, speakers });
    }
  };

  const reassignSegment = async (
    segment: MeetingSegment,
    speakerId: string,
  ) => {
    if (speakerId === segment.speakerId) return;
    onChange({
      segments: segments.map((s) =>
        s.id === segment.id ? { ...s, speakerId, labelSource: "manual" } : s,
      ),
      speakers,
    });
    const result = await commands.assignMeetingSegmentSpeaker(
      segment.id,
      speakerId,
    );
    if (result.status === "error") {
      toast.error(result.error);
      onChange({ segments, speakers });
    }
  };

  /// Folds one speaker into another. The source row disappears, so this cannot
  /// be applied optimistically without reproducing the backend's cascade —
  /// re-reading is both simpler and guaranteed to match.
  const mergeSpeakers = async (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    const result = await commands.mergeMeetingSpeakers(targetId, sourceId);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    toast.success(t("meeting.library.merged", { count: result.data }));
    await reload();
  };

  const addSpeaker = async () => {
    const name = newSpeakerDraft.trim();
    setAddingSpeaker(false);
    setNewSpeakerDraft("");
    if (!name) return;
    const result = await commands.addMeetingSpeaker(meetingId, name);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    onChange({ segments, speakers: [...speakers, result.data] });
  };

  const reload = async () => {
    const [nextSegments, nextSpeakers] = await Promise.all([
      commands.getMeetingSegments(meetingId),
      commands.getMeetingSpeakers(meetingId),
    ]);
    if (nextSegments.status === "ok" && nextSpeakers.status === "ok") {
      onChange({ segments: nextSegments.data, speakers: nextSpeakers.data });
    }
  };

  return (
    <div>
      {/* Speaker roster. Renaming and merging are speaker-level operations, so
          they live above the transcript rather than being repeated on the line
          that happens to be visible. */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {speakers.map((speaker) => (
          <div
            key={speaker.id}
            className="flex items-center gap-1 rounded-md border border-hairline-strong bg-fill-1 px-1.5 py-0.5"
          >
            {renamingSpeaker === speaker.id ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => void commitSpeakerName(speaker.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void commitSpeakerName(speaker.id);
                  if (e.key === "Escape") setRenamingSpeaker(null);
                }}
                placeholder={t("meeting.panel.namePlaceholder")}
                className="w-24 bg-transparent text-[11px] outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setRenamingSpeaker(speaker.id);
                  setNameDraft(speaker.displayName ?? "");
                }}
                title={t("meeting.panel.renameHint")}
                className="text-[11px] font-medium hover:underline"
                style={{ color: speakerColor(Number(speaker.colorIndex)) }}
              >
                {nameFor(speaker, speaker.lane)}
              </button>
            )}

            {speakers.length > 1 && (
              <select
                value=""
                onChange={(e) => void mergeSpeakers(speaker.id, e.target.value)}
                title={t("meeting.library.mergeInto")}
                className="cursor-pointer bg-transparent text-[10px] text-text-subtle outline-none hover:text-text"
              >
                <option value="">{t("meeting.library.mergeInto")}</option>
                {speakers
                  .filter((other) => other.id !== speaker.id)
                  .map((other) => (
                    <option key={other.id} value={other.id}>
                      {nameFor(other, other.lane)}
                    </option>
                  ))}
              </select>
            )}
          </div>
        ))}

        {addingSpeaker ? (
          <span className="flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5">
            <input
              autoFocus
              value={newSpeakerDraft}
              onChange={(e) => setNewSpeakerDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addSpeaker();
                if (e.key === "Escape") {
                  setAddingSpeaker(false);
                  setNewSpeakerDraft("");
                }
              }}
              placeholder={t("meeting.panel.namePlaceholder")}
              className="w-24 bg-transparent text-[11px] outline-none"
            />
            <button
              type="button"
              onClick={() => void addSpeaker()}
              title={t("meeting.library.saveTitle")}
              className="text-text-subtle hover:text-text"
            >
              <Check width={12} height={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                setAddingSpeaker(false);
                setNewSpeakerDraft("");
              }}
              title={t("meeting.library.cancelRename")}
              className="text-text-subtle hover:text-text"
            >
              <X width={12} height={12} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAddingSpeaker(true)}
            className="flex items-center gap-1 rounded-md border border-hairline-strong px-1.5 py-0.5 text-[11px] text-text-subtle hover:text-text"
          >
            <Plus width={12} height={12} />
            {t("meeting.library.addSpeaker")}
          </button>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto pr-1">
        {segments.map((segment) => {
          const speaker = segment.speakerId
            ? speakerById.get(segment.speakerId)
            : undefined;
          return (
            <div key={segment.id} className="mb-1 flex items-start gap-1.5">
              <select
                value={segment.speakerId ?? ""}
                onChange={(e) => void reassignSegment(segment, e.target.value)}
                title={t("meeting.library.reassignLine")}
                className="mt-[1px] max-w-[7.5rem] shrink-0 cursor-pointer truncate bg-transparent text-[12px] font-medium outline-none"
                style={{
                  color: speakerColor(Number(speaker?.colorIndex ?? 0)),
                }}
              >
                {speakers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {nameFor(option, option.lane)}
                  </option>
                ))}
              </select>

              {editingId === segment.id ? (
                <textarea
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
                  className="min-w-0 flex-1 resize-y rounded border border-hairline-strong bg-surface-2 px-1 py-[1px] text-[12px] leading-snug outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(segment.id);
                    setTextDraft(segment.text);
                  }}
                  title={t("meeting.library.editLine")}
                  className="min-w-0 flex-1 rounded px-1 text-left text-[12px] leading-snug text-text-muted hover:bg-fill-1 hover:text-text"
                >
                  {segment.text}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
