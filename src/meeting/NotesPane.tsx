import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { commands } from "@/bindings";
import { continueBullet, NOTES_SAVE_DEBOUNCE_MS } from "@/lib/notes";

/**
 * The notepad half of the meeting panel.
 *
 * Design notes:
 * - Two documents, never one. `mine` is exactly what the user typed and is
 *   never rewritten; `enhanced` is the AI pass over it. Both are editable and
 *   both are kept, so a disappointing enhancement costs nothing.
 * - Notes typed *before* a meeting starts follow you into it. Someone opening
 *   the panel to jot an agenda and then pressing Start should not watch it
 *   vanish, so text with no meeting attached is held in memory and written to
 *   the meeting the moment one exists.
 * - Saves are debounced and fire-and-forget. Every keystroke reaching SQLite
 *   would be absurd, and a save that fails is worth a message, not a modal —
 *   the text is still on screen either way.
 */

type Tab = "mine" | "enhanced";

interface NotesPaneProps {
  /** The meeting the notes belong to, or null while none is on screen. */
  meetingId: string | null;
  /** Capture is running. Enhancement waits for the meeting to finish. */
  capturing: boolean;
  /** A finished meeting is on screen — the moment to offer enhancement. */
  finished: boolean;
  /** There are transcript lines to enhance from. */
  hasTranscript: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Set by the panel's split, which owns the divider.  */
  style?: React.CSSProperties;
}

export const NotesPane: React.FC<NotesPaneProps> = ({
  meetingId,
  capturing,
  finished,
  hasTranscript,
  collapsed,
  onToggleCollapsed,
  style,
}) => {
  const { t } = useTranslation();

  const [mine, setMine] = useState("");
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("mine");
  const [enhancing, setEnhancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerDismissed, setOfferDismissed] = useState(false);

  const saveTimer = useRef<number | null>(null);
  // The meeting the text on screen belongs to. `null` means it is scratch —
  // typed before any meeting existed — which is what makes carrying it into
  // the next meeting distinguishable from resurrecting the last one's.
  const attachedId = useRef<string | null>(null);
  // Read by the debounced save, which captures its closure once.
  const draft = useRef({ mine: "", enhanced: "" });
  draft.current = { mine, enhanced: enhanced ?? "" };

  const flush = useCallback((id: string, which: Tab) => {
    if (which === "enhanced") {
      void commands.setMeetingEnhancedNotes(id, draft.current.enhanced);
    } else {
      void commands.setMeetingNotes(id, draft.current.mine);
    }
  }, []);

  const scheduleSave = useCallback(
    (which: Tab) => {
      const id = attachedId.current;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (!id) return; // Scratch notes live in memory until a meeting exists.
      saveTimer.current = window.setTimeout(
        () => flush(id, which),
        NOTES_SAVE_DEBOUNCE_MS,
      );
    },
    [flush],
  );

  // Follow the meeting on screen. Every branch here is a real sequence the
  // panel produces, and getting one wrong either loses notes or shows the
  // previous meeting's notes under this meeting's transcript.
  useEffect(() => {
    let active = true;

    if (meetingId === null) {
      // The panel dropped its meeting — a new one is starting. Notes belonging
      // to the meeting that just left the screen go with it.
      if (attachedId.current !== null) {
        attachedId.current = null;
        setMine("");
        setEnhanced(null);
        setTab("mine");
        setOfferDismissed(false);
      }
      return;
    }

    if (attachedId.current === meetingId) return;

    if (attachedId.current === null && draft.current.mine.trim() !== "") {
      // Scratch notes, typed before this meeting existed. Adopt them.
      attachedId.current = meetingId;
      void commands.setMeetingNotes(meetingId, draft.current.mine);
      setEnhanced(null);
      setTab("mine");
      setOfferDismissed(false);
      return;
    }

    attachedId.current = meetingId;
    setOfferDismissed(false);
    void commands.getMeetingNotes(meetingId).then((result) => {
      // A meeting swapped underneath the query must not be written over.
      if (!active || attachedId.current !== meetingId) return;
      if (result.status === "error") {
        setError(result.error);
        return;
      }
      setMine(result.data.notes ?? "");
      setEnhanced(result.data.enhanced);
      setTab(result.data.enhanced ? "enhanced" : "mine");
    });

    return () => {
      active = false;
    };
  }, [meetingId]);

  // An enhancement started from the library lands here too — same row, two
  // windows.
  useEffect(() => {
    const unlisten = listen<{ meetingId: string; body: string }>(
      "meeting-notes-enhanced",
      (event) => {
        if (event.payload.meetingId !== attachedId.current) return;
        setEnhanced(event.payload.body);
        setTab("enhanced");
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // A pending save must not be lost to the panel closing or the window
  // reloading. `flush` on unmount covers the first; `beforeunload` the second.
  useEffect(() => {
    const save = () => {
      if (saveTimer.current === null) return;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const id = attachedId.current;
      if (id) flush(id, "mine");
    };
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("beforeunload", save);
      save();
    };
  }, [flush]);

  const handleEnhance = async () => {
    const id = meetingId;
    // The notes on screen must already belong to this meeting. Enhancing
    // before the load effect has caught up would push the previous meeting's
    // text into this one.
    if (!id || attachedId.current !== id) return;
    // Whatever is in the box has to be on disk before the model reads it,
    // otherwise it enhances the notes as they were 600ms ago.
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const pending = await commands.setMeetingNotes(id, draft.current.mine);
    if (pending.status === "error") {
      setError(pending.error);
      return;
    }

    setError(null);
    setEnhancing(true);
    const result = await commands.enhanceMeetingNotes(id);
    setEnhancing(false);
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    setEnhanced(result.data);
    setTab("enhanced");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canEnhance) void handleEnhance();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;

    const field = event.currentTarget;
    // Only with a collapsed caret: extending a selection is a replacement, and
    // continuing a bullet through one would eat the selected text.
    if (field.selectionStart !== field.selectionEnd) return;
    const next = continueBullet(field.value, field.selectionStart);
    if (!next) return;

    event.preventDefault();
    if (tab === "enhanced") setEnhanced(next.value);
    else setMine(next.value);
    scheduleSave(tab);
    // React re-renders before the caret can be placed, so this waits a frame.
    requestAnimationFrame(() => {
      field.setSelectionRange(next.caret, next.caret);
    });
  };

  const value = tab === "enhanced" ? (enhanced ?? "") : mine;
  const canEnhance =
    meetingId !== null && hasTranscript && !capturing && !enhancing;

  // The offer at the close of the meeting. Not a dialog: the wrap-up summary is
  // already arriving in the pane above, and a modal over it would be the second
  // thing demanding attention from someone who has just left a call.
  const showOffer =
    finished && hasTranscript && enhanced === null && !offerDismissed;

  const placeholder = useMemo(() => {
    if (meetingId === null) return t("meeting.notes.placeholderIdle");
    return capturing
      ? t("meeting.notes.placeholderLive")
      : t("meeting.notes.placeholder");
  }, [meetingId, capturing, t]);

  return (
    <section
      style={collapsed ? undefined : style}
      className={`flex min-h-0 flex-col bg-surface-2/30 ${
        collapsed ? "flex-none border-t border-hairline" : ""
      }`}
      aria-label={t("meeting.notes.heading")}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 px-2.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={
            collapsed ? t("meeting.notes.expand") : t("meeting.notes.collapse")
          }
          aria-expanded={!collapsed}
          className="flex items-center gap-1 rounded p-0.5 text-[10px] font-semibold uppercase tracking-[0.07em] text-text-subtle transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {collapsed ? (
            <ChevronUp className="h-3 w-3" aria-hidden />
          ) : (
            <ChevronDown className="h-3 w-3" aria-hidden />
          )}
          {t("meeting.notes.heading")}
        </button>

        {/* The two versions. Only ever shown once both exist — a single-tab
            tab bar is chrome that explains nothing. */}
        {enhanced !== null && (
          <div className="ml-1 flex items-center gap-0.5 rounded-md bg-fill-2 p-[2px]">
            {(["mine", "enhanced"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTab(option)}
                className={`rounded px-1.5 py-[1px] text-[10px] font-medium transition-colors duration-150 ${
                  tab === option
                    ? "bg-surface-1 text-text shadow-sm"
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

        <span className="flex-1" />

        <button
          type="button"
          onClick={() => void handleEnhance()}
          disabled={!canEnhance}
          title={
            capturing
              ? t("meeting.notes.enhanceDuringMeeting")
              : t("meeting.notes.enhanceHint")
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[2px] text-[11px] font-medium text-accent transition-colors duration-150 hover:bg-accent/10 disabled:pointer-events-none disabled:text-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Sparkles
            className={`h-3 w-3 ${enhancing ? "animate-pulse" : ""}`}
            aria-hidden
          />
          {enhancing
            ? t("meeting.notes.enhancing")
            : enhanced !== null
              ? t("meeting.notes.reEnhance")
              : t("meeting.notes.enhance")}
        </button>
      </div>

      {!collapsed && (
        <>
          {showOffer && (
            <div className="animate-rise mx-2.5 mb-1.5 shrink-0 rounded-lg border border-accent/30 bg-accent/[0.07] px-2 py-1.5">
              <p className="text-[11px] leading-snug text-text-muted">
                {t("meeting.notes.offerBody")}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleEnhance()}
                  disabled={!canEnhance}
                  className="rounded-md bg-accent px-2 py-[3px] text-[11px] font-medium text-canvas transition-colors duration-150 hover:bg-accent-bright disabled:opacity-40"
                >
                  {enhancing
                    ? t("meeting.notes.enhancing")
                    : t("meeting.notes.offerAccept")}
                </button>
                <button
                  type="button"
                  onClick={() => setOfferDismissed(true)}
                  className="text-[10px] text-text-subtle transition-colors duration-150 hover:text-text"
                >
                  {t("meeting.notes.offerDismiss")}
                </button>
              </div>
            </div>
          )}

          <textarea
            value={value}
            onChange={(event) => {
              if (tab === "enhanced") setEnhanced(event.target.value);
              else setMine(event.target.value);
              scheduleSave(tab);
            }}
            onBlur={() => {
              const id = attachedId.current;
              if (!id) return;
              if (saveTimer.current !== null) {
                window.clearTimeout(saveTimer.current);
                saveTimer.current = null;
              }
              flush(id, tab);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            spellCheck
            className="min-h-0 flex-1 resize-none bg-transparent px-3 pb-2.5 text-[13px] leading-[1.55] text-text outline-none placeholder:text-text-faint"
          />

          {error && (
            <p className="animate-rise mx-2.5 mb-2 shrink-0 rounded-lg bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
};

export default NotesPane;
