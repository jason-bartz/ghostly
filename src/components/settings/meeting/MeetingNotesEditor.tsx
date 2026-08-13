import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { commands } from "../../../bindings";
import { noteKeyEdit, NOTES_SAVE_DEBOUNCE_MS } from "@/lib/notes";
import type { MeetingNotes } from "../../../bindings";

/**
 * The notepad, as it appears inside an expanded library row.
 *
 * The panel's [`NotesPane`](../../../meeting/NotesPane.tsx) is the same two
 * documents under different constraints: it lives beside a live transcript in a
 * 400pt window and has to worry about meetings starting underneath it. This one
 * is a plain editor for a meeting that is already over, so it stays separate
 * rather than growing a prop for every difference.
 */

type Tab = "mine" | "enhanced";

interface MeetingNotesEditorProps {
  meetingId: string;
  notes: MeetingNotes;
  /** Enhancement needs lines to work from. */
  hasTranscript: boolean;
  /** Lets the list keep its row in step without a reload. */
  onChange: (notes: MeetingNotes) => void;
}

export const MeetingNotesEditor: React.FC<MeetingNotesEditorProps> = ({
  meetingId,
  notes,
  hasTranscript,
  onChange,
}) => {
  const { t } = useTranslation();

  const [mine, setMine] = useState(notes.notes ?? "");
  const [enhanced, setEnhanced] = useState<string | null>(notes.enhanced);
  const [tab, setTab] = useState<Tab>(notes.enhanced ? "enhanced" : "mine");
  const [enhancing, setEnhancing] = useState(false);

  const saveTimer = useRef<number | null>(null);
  const draft = useRef({ mine: "", enhanced: "" });
  draft.current = { mine, enhanced: enhanced ?? "" };
  // Read only when the meeting changes, so the reset effect does not have to
  // depend on a prop that changes for unrelated reasons.
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Keyed on the meeting alone, deliberately. The list reloads its rows on any
  // search or filter change, and reacting to the `notes` prop would let one of
  // those reloads overwrite the sentence being typed with whatever was on disk
  // before the debounced save landed.
  useEffect(() => {
    setMine(notesRef.current.notes ?? "");
    setEnhanced(notesRef.current.enhanced);
    setTab(notesRef.current.enhanced ? "enhanced" : "mine");
  }, [meetingId]);

  const flush = useCallback(
    (which: Tab) => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const body =
        which === "enhanced" ? draft.current.enhanced : draft.current.mine;
      const command =
        which === "enhanced"
          ? commands.setMeetingEnhancedNotes
          : commands.setMeetingNotes;
      void command(meetingId, body).then((result) => {
        if (result.status === "error") toast.error(result.error);
      });
    },
    [meetingId],
  );

  const scheduleSave = useCallback(
    (which: Tab) => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(
        () => flush(which),
        NOTES_SAVE_DEBOUNCE_MS,
      );
    },
    [flush],
  );

  // Collapsing the row unmounts this, and a debounced save in flight would go
  // with it.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const handleEnhance = async () => {
    // The model must read what is in the box, not what was in it a moment ago.
    const pending = await commands.setMeetingNotes(
      meetingId,
      draft.current.mine,
    );
    if (pending.status === "error") {
      toast.error(pending.error);
      return;
    }
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    setEnhancing(true);
    const result = await commands.enhanceMeetingNotes(meetingId);
    setEnhancing(false);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    setEnhanced(result.data);
    setTab("enhanced");
    onChange({
      ...notes,
      notes: draft.current.mine || null,
      enhanced: result.data,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    // Shared with the panel's notepad on purpose — see `@/lib/notes`.
    const next = noteKeyEdit(event, field);
    if (!next) return;

    event.preventDefault();
    if (tab === "enhanced") setEnhanced(next.value);
    else setMine(next.value);
    scheduleSave(tab);
    requestAnimationFrame(() =>
      field.setSelectionRange(next.caret, next.caret),
    );
  };

  const value = tab === "enhanced" ? (enhanced ?? "") : mine;

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-subtle">
          {t("meeting.notes.heading")}
        </p>

        {enhanced !== null && (
          <div className="flex items-center gap-0.5 rounded-md bg-fill-2 p-[2px]">
            {(["mine", "enhanced"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTab(option)}
                className={`rounded px-1.5 py-[1px] text-[11px] font-medium transition-colors ${
                  tab === option
                    ? "bg-surface-2 text-text shadow-sm"
                    : "text-text-subtle hover:text-text"
                }`}
              >
                {t(
                  option === "mine"
                    ? "meeting.notes.tabMine"
                    : "meeting.notes.tabEnhanced",
                )}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleEnhance()}
          disabled={enhancing || !hasTranscript}
          title={
            hasTranscript
              ? t("meeting.notes.enhanceHintLibrary")
              : t("meeting.notes.enhanceNoTranscript")
          }
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-[2px] text-[11px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:pointer-events-none disabled:text-text-faint"
        >
          {enhancing ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-3 w-3" aria-hidden />
          )}
          {enhancing
            ? t("meeting.notes.enhancing")
            : enhanced !== null
              ? t("meeting.notes.reEnhance")
              : t("meeting.notes.enhance")}
        </button>
      </div>

      <textarea
        value={value}
        onChange={(event) => {
          if (tab === "enhanced") setEnhanced(event.target.value);
          else setMine(event.target.value);
          scheduleSave(tab);
        }}
        onBlur={() => flush(tab)}
        onKeyDown={handleKeyDown}
        placeholder={t("meeting.notes.placeholder")}
        // Grows with the content up to a point, then scrolls: a page of notes
        // should not push the transcript off the bottom of the row.
        rows={Math.min(18, Math.max(4, value.split("\n").length + 1))}
        className="w-full resize-y rounded-lg border border-hairline bg-surface-2 px-2.5 py-2 font-sans text-[12px] leading-[1.55] text-text-muted outline-none focus:border-accent/60"
      />
    </div>
  );
};
