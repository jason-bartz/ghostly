import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  BellRing,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Loader2,
  NotebookPen,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { usePanelTheme } from "./usePanelTheme";
import { NotesPane, type NotesPaneHandle } from "./NotesPane";
import { AskPane, type AskPaneHandle } from "./AskPane";
import { RichText, stripCitations } from "./RichText";
import { MiniPlayer } from "./MiniPlayer";
import { TrafficLights } from "./TrafficLights";
import { GhostlyMark } from "@/components/icons/GhostlyMark";
import { PlatformLogo } from "@/components/icons/PlatformLogo";
import { commands } from "@/bindings";
import type { MeetingSegment, MeetingStatus, TitleSource } from "@/bindings";
import { groupIntoBlocks, blockText } from "@/lib/meetingBlocks";

/**
 * The floating meeting panel: live transcript above, a workspace below.
 *
 * Design notes:
 * - Two panes, split by a draggable divider: the transcript is what the meeting
 *   is saying, the workspace is what you do with it — the notepad, or Ask, a
 *   conversation with the meeting itself. Ask shares the notepad's pane rather
 *   than replacing the transcript, because the point is asking about what is
 *   being said while it is still being said. The split and the last tab are
 *   remembered: they are working preferences, not per-meeting decisions.
 * - The meeting is introduced, not just timed. A header row carries the logo
 *   of the platform the call is on and the meeting's name — written by Ghostly
 *   from what is being discussed once there is enough to go on, and never over
 *   a name the user typed. Clearing the name hands naming back to Ghostly.
 * - Transport lives in the title bar: the clock, pause, end. It used to be a
 *   footer of three pills, which cost a row of transcript for the whole
 *   meeting and put "End meeting" a careless click from "Where were we?".
 *   Catching up is now an Ask preset, alongside the other things people
 *   actually want mid-call.
 * - Auto-scroll sticks to the bottom but releases the moment the user scrolls
 *   up. Yanking someone back to the live edge while they are reading is the
 *   single most annoying thing a live transcript can do. A "Live" pill offers
 *   the way back instead. A summary arriving, or a citation being followed, are
 *   the exceptions: the user asked for that, so the panel goes there.
 * - The transcript reads as paragraphs, not as a chat log. It used to attribute
 *   and time-stamp every utterance, but "You" and "Participant" were never more
 *   than which audio lane the segment arrived on. A label that is wrong that
 *   often is worse than no label. (The AI still sees the lane, with that
 *   caveat, because "who committed to what" is half of what people ask it.)
 * - Selecting text in the transcript offers "Ask about this" — the shortest
 *   path from "wait, what did she mean?" to an answer.
 * - The transcript is deliberately NOT cleared when capture stops. The panel
 *   stays open afterwards so the user can read it, ask about it and export it.
 *   It *is* cleared when the next meeting starts — see `meeting-starting`.
 * - Every control applies its effect locally before the command resolves.
 *   Ending a meeting joins a worker thread and pausing rebuilds the tray menu
 *   on the main thread, so waiting for the round trip made the buttons feel
 *   broken. `pending` holds the optimistic value until the authoritative status
 *   event lands.
 * - This window also hosts the auto-connect consent prompt. Ghostly normally
 *   runs with its main window hidden behind the tray icon, so a prompt that
 *   lived only there could mean capture starting with nothing visible to
 *   cancel.
 * - Segment state lives in this window only. It deliberately does not use the
 *   settings store, whose subscription has no selector and would re-render
 *   every consumer on each transcript chunk.
 */

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = (total % 60).toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** `h:mm:ss` past the hour, `m:ss` below it. */
function formatDuration(seconds: number): string {
  return formatClock(seconds * 1000);
}

function clampSplit(value: number): number {
  // A settings file edited by hand, or a stored value from a future version,
  // must not be able to collapse a pane to zero height.
  if (!Number.isFinite(value)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

/** Turns a meeting name into something safe to hand a save dialog. */
function suggestedFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${cleaned || "meeting"}.md`;
}

interface DetectedPayload {
  bundleId: string;
  displayName: string;
  platform: string | null;
  countdownSecs: number | null;
}

interface SummaryPayload {
  meetingId: string;
  body: string;
}

interface RefinedPayload {
  meetingId: string;
  segmentId: number;
  text: string;
}

interface TitlePayload {
  meetingId: string;
  title: string;
  source: TitleSource;
}

/**
 * Live capture activity, sampled by the backend a few times a second.
 *
 * A line only reaches the panel once its speaker pauses *and* the model has
 * finished with it, so a long sentence leaves the transcript looking stalled for
 * several seconds. This is what fills that gap.
 */
interface ActivityPayload {
  /** The user is mid-utterance. */
  mic: boolean;
  /** The far side is mid-utterance. */
  system: boolean;
  /** Utterances waiting on the transcription worker. */
  pending: number;
}

const IDLE_ACTIVITY: ActivityPayload = {
  mic: false,
  system: false,
  pending: 0,
};

/**
 * Three bouncing dots — the same shape every messaging app uses for "someone is
 * typing", which is exactly the thing being communicated here.
 */
const TypingDots: React.FC = () => (
  <span
    className="inline-flex items-center gap-[3px] rounded-full bg-fill-2 px-2 py-[6px]"
    aria-hidden
  >
    <span className="typing-dot" />
    <span className="typing-dot" />
    <span className="typing-dot" />
  </span>
);

/**
 * Share of the panel given to the transcript before the user says otherwise.
 * Mirrors `MeetingSettings::default` on the Rust side, which is authoritative;
 * this is only what the first frame renders with while settings load.
 */
const DEFAULT_SPLIT = 0.58;
/** Neither pane may be squeezed to nothing. */
const MIN_SPLIT = 0.2;
const MAX_SPLIT = 0.85;

/** Which workspace tab was last open. A per-window convenience, so local. */
const PANE_STORAGE_KEY = "ghostly:meeting-pane";
type PaneTab = "notes" | "ask";

function loadPaneTab(): PaneTab {
  try {
    return localStorage.getItem(PANE_STORAGE_KEY) === "ask" ? "ask" : "notes";
  } catch {
    return "notes";
  }
}

/** How long a transcript card stays lit after a citation lands on it. */
const CITE_FLASH_MS = 1800;

/** An action applied locally while its command is still in flight. */
type Pending = {
  paused?: boolean;
  ending?: boolean;
  starting?: boolean;
  exporting?: boolean;
  copying?: boolean;
};

/**
 * The panel's buttons.
 *
 * Flat by design: no borders, no fills at rest, no shadows. Exactly one control
 * per state carries a fill — the thing you most likely came to press — and the
 * rest are quiet until the cursor finds them.
 *
 * `shrink-0 whitespace-nowrap` is load-bearing, not tidiness: the panel
 * resizes down to 240pt, and flex children shrink below their content by
 * default — labels spilled out of their own padding and across their
 * neighbours.
 */
const PanelButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger" | "icon";
  }
> = ({ variant = "ghost", className = "", ...props }) => {
  const base =
    "inline-flex shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap rounded-lg text-[11.5px] font-medium " +
    "transition-[background-color,color,opacity,transform] duration-150 " +
    "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
  const variants = {
    primary:
      "h-[24px] px-2.5 bg-accent text-canvas hover:bg-accent-bright active:bg-accent-deep",
    ghost:
      "h-[24px] px-2.5 text-text-muted hover:bg-fill-2 hover:text-text active:bg-fill-3",
    danger:
      "h-[24px] px-2.5 bg-danger/12 text-danger hover:bg-danger/20 active:bg-danger/25",
    icon: "h-[24px] w-[24px] text-text-muted hover:bg-fill-2 hover:text-text active:bg-fill-3",
  };
  return (
    <button
      type="button"
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    />
  );
};

/** The wrap-up card at the foot of a finished transcript. */
const SummaryCard: React.FC<{
  heading: string;
  body: string;
  onCite: (ms: number) => void;
  onAddToNotes: (text: string) => void;
  onDismiss: () => void;
  innerRef: React.Ref<HTMLDivElement>;
}> = ({ heading, body, onCite, onAddToNotes, onDismiss, innerRef }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div
      ref={innerRef}
      className="animate-rise mt-3 overflow-hidden rounded-[14px] bg-gradient-to-b from-accent/[0.10] to-accent/[0.04] ring-1 ring-accent/20"
    >
      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5">
        <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden />
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-accent-bright">
          {heading}
        </span>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard
              .writeText(stripCitations(body))
              .then(() => setCopied(true))
          }
          title={t("meeting.ask.copy")}
          aria-label={t("meeting.ask.copy")}
          className="rounded-md p-1 text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text"
        >
          {copied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onAddToNotes(body)}
          title={t("meeting.ask.addToNotes")}
          aria-label={t("meeting.ask.addToNotes")}
          className="rounded-md p-1 text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text"
        >
          <NotebookPen className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onDismiss}
          title={t("meeting.panel.dismiss")}
          aria-label={t("meeting.panel.dismiss")}
          className="rounded-md p-1 text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="px-3 pb-3">
        <RichText text={body} onCite={onCite} className="text-[12.5px]" />
      </div>
    </div>
  );
};

const MeetingPanel: React.FC = () => {
  const { t } = useTranslation();
  usePanelTheme();

  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [segments, setSegments] = useState<MeetingSegment[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mention, setMention] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedPayload | null>(null);
  // The countdown's starting value, so the bar can show how much is left.
  const [countdownFrom, setCountdownFrom] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityPayload>(IDLE_ACTIVITY);
  const [autoEnded, setAutoEnded] = useState(false);
  const [pending, setPending] = useState<Pending>({});

  // Held separately from `status.title`, which reverts to the default snapshot
  // the moment capture stops — the panel would otherwise forget the meeting's
  // name while still showing its transcript. Same for its platform.
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  const [titleSource, setTitleSource] = useState<TitleSource>("default");
  const [platform, setPlatform] = useState<string | null>(null);
  // A name is being written for this meeting right now.
  const [naming, setNaming] = useState(false);
  // Bumped when Ghostly renames the meeting, to replay the reveal.
  const [titleRevision, setTitleRevision] = useState(0);
  // `null` means "not editing"; the empty string is a legitimate draft.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // The meeting the panel is showing. Not `status.meetingId`: that goes null
  // the moment capture stops, while the panel deliberately keeps the finished
  // transcript on screen — and renaming it, exporting it or asking about it
  // all still need an id. Cleared only when the next meeting begins.
  const [meetingId, setMeetingId] = useState<string | null>(null);

  // Share of the panel's height given to the transcript. The workspace takes
  // the rest. Loaded from settings on mount and written back when a drag ends —
  // per-pixel writes during the drag would hammer the settings store.
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [paneTab, setPaneTab] = useState<PaneTab>(loadPaneTab);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  // Shrunk to the mini player. The window's geometry is Rust's business — see
  // `meetings::panel` — so this is only which of the two faces to draw, and the
  // backend is authoritative: it restores the panel whenever it is hidden, and
  // says so with `meeting-panel-minimized`.
  const [minimized, setMinimized] = useState(false);

  // Scrolled away from the live edge — offers the way back.
  const [detached, setDetached] = useState(false);
  // The card a citation just landed on.
  const [flashKey, setFlashKey] = useState<number | null>(null);
  // "Ask about this", floating over a transcript selection.
  const [selection, setSelection] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<NotesPaneHandle>(null);
  const askRef = useRef<AskPaneHandle>(null);
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const stickToBottom = useRef(true);
  const draggingSplit = useRef(false);
  // Mirrors `meetingId` for the event handlers, which capture their closure
  // once on mount and would otherwise read a stale value.
  const meetingIdRef = useRef<string | null>(null);

  const adoptMeeting = useCallback((id: string | null) => {
    meetingIdRef.current = id;
    setMeetingId(id);
  }, []);

  /**
   * The transcript as paragraphs, broken where the speaker actually stopped.
   * See `@/lib/meetingBlocks` for the rule and why the speaker names are gone.
   */
  const blocks = useMemo(() => groupIntoBlocks(segments), [segments]);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setSummary(null);
    setSummarizing(false);
    setMention(null);
    setError(null);
    setNotice(null);
    setAutoEnded(false);
    setActivity(IDLE_ACTIVITY);
    setTitleDraft(null);
    setMeetingTitle(null);
    setTitleSource("default");
    setPlatform(null);
    setNaming(false);
    setElapsed(0);
    setSelection(null);
    setDetached(false);
    stickToBottom.current = true;
  }, []);

  const refreshTranscript = useCallback(async (meetingId: string) => {
    const segmentsResult = await commands.getMeetingSegments(meetingId);
    // A meeting that ended while the query was in flight must not have the
    // next one's transcript written over it.
    if (meetingIdRef.current !== meetingId) return;
    if (segmentsResult.status === "ok") setSegments(segmentsResult.data);
  }, []);

  const adoptStatusIdentity = useCallback((next: MeetingStatus) => {
    if (!next.meetingId) return;
    setMeetingTitle(next.title);
    setTitleSource(next.titleSource);
    setPlatform(next.platform);
  }, []);

  useEffect(() => {
    let active = true;

    void commands.getMeetingSettings().then((settings) => {
      if (!active) return;
      setSplit(clampSplit(settings.notesSplit));
      setNotesCollapsed(settings.notesCollapsed);
    });

    void commands.getMeetingStatus().then((current) => {
      if (!active) return;
      setStatus(current);
      adoptMeeting(current.meetingId);
      if (current.meetingId) {
        adoptStatusIdentity(current);
        void refreshTranscript(current.meetingId);
      }
    });

    // Fired the moment start is pressed, before the system-audio tap comes up.
    // The previous meeting's transcript and wrap-up summary both stay on screen
    // after it ends, so without this the new meeting would open on top of them.
    const unlistenStarting = listen("meeting-starting", () => {
      if (!active) return;
      adoptMeeting(null);
      clearTranscript();
      setPending({ starting: true });
    });

    const unlistenStartFailed = listen<string>(
      "meeting-start-failed",
      (event) => {
        if (!active) return;
        setPending({});
        setError(event.payload);
      },
    );

    const unlistenStatus = listen<{ status: MeetingStatus }>(
      "meeting-status",
      (event) => {
        if (!active) return;
        const next = event.payload.status;
        setStatus(next);
        // The authoritative answer has arrived; drop the optimistic overrides.
        setPending({});
        // A new meeting replaces the transcript; the *end* of one keeps it, so
        // a status with no meeting id leaves the panel showing what it has.
        if (next.meetingId && next.meetingId !== meetingIdRef.current) {
          adoptMeeting(next.meetingId);
          clearTranscript();
          void refreshTranscript(next.meetingId);
        }
        adoptStatusIdentity(next);
      },
    );

    // The event still carries a speaker row — the summariser uses it — but the
    // transcript no longer renders one, so it is ignored here.
    const unlistenSegment = listen<{ segment: MeetingSegment }>(
      "meeting-segment",
      (event) => {
        if (!active) return;
        const incoming = event.payload.segment;
        // A segment can beat the status event that announces its meeting; when
        // it does, it is the authority on which meeting the panel is showing.
        if (meetingIdRef.current === null) adoptMeeting(incoming.meetingId);
        else if (incoming.meetingId !== meetingIdRef.current) return;
        setSegments((previous) =>
          // A refresh racing an event can deliver the same row twice, which
          // would duplicate the line and the React key.
          previous.some((s) => s.id === incoming.id)
            ? previous
            : [...previous, incoming],
        );
      },
    );

    // Somebody is mid-sentence, or the model is still working through what they
    // already said. Edge-triggered on the backend, so this fires once per state
    // change rather than on a timer.
    const unlistenActivity = listen<ActivityPayload>(
      "meeting-activity",
      (event) => {
        if (active) setActivity(event.payload);
      },
    );

    // A line the AI cleaned up. Replaces the verbatim text in place rather than
    // appending, so the transcript never shows the same sentence twice.
    const unlistenRefined = listen<RefinedPayload>(
      "meeting-segment-refined",
      (event) => {
        if (!active) return;
        const { meetingId, segmentId, text } = event.payload;
        if (meetingId !== meetingIdRef.current) return;
        setSegments((previous) =>
          previous.map((s) => (s.id === segmentId ? { ...s, text } : s)),
        );
      },
    );

    // Someone said your name. The highest-value alert in a meeting, and the one
    // most likely to be missed, so it gets a banner rather than another line.
    const unlistenMention = listen<{ text: string }>(
      "meeting-mention",
      (event) => {
        if (active) setMention(event.payload.text);
      },
    );

    // Ending a meeting kicks off a wrap-up automatically.
    const unlistenSummarizing = listen("meeting-summarizing", () => {
      if (active) setSummarizing(true);
    });
    const unlistenFinal = listen<SummaryPayload>(
      "meeting-final-summary",
      (event) => {
        if (!active) return;
        setSummarizing(false);
        // The wrap-up is produced asynchronously and can land after the user
        // has already started their next call; showing it there would present
        // the last meeting's summary as this one's.
        if (
          meetingIdRef.current !== null &&
          event.payload.meetingId !== meetingIdRef.current
        ) {
          return;
        }
        setSummary(event.payload.body);
      },
    );
    const unlistenFinalFailed = listen("meeting-final-summary-failed", () => {
      if (active) setSummarizing(false);
    });

    // Ghostly named the meeting, or the user renamed it from the library.
    const unlistenTitle = listen<TitlePayload>("meeting-title", (event) => {
      if (!active) return;
      const { meetingId: id, title, source } = event.payload;
      if (id !== meetingIdRef.current) return;
      setMeetingTitle(title);
      setTitleSource(source);
      if (source === "ai") setTitleRevision((n) => n + 1);
    });
    const unlistenTitlePending = listen<{
      meetingId: string;
      pending: boolean;
    }>("meeting-title-pending", (event) => {
      if (!active) return;
      if (event.payload.meetingId !== meetingIdRef.current) return;
      setNaming(event.payload.pending);
    });

    // Silence auto-end. Said out loud, because a meeting that ended without
    // anyone pressing anything otherwise reads as a crash.
    const unlistenAutoEnded = listen("meeting-auto-ended", () => {
      if (active) setAutoEnded(true);
    });

    const unlistenDetected = listen<DetectedPayload>(
      "meeting-detected",
      (event) => {
        if (!active) return;
        setDetected(event.payload);
        setCountdownFrom((previous) =>
          event.payload.countdownSecs === null
            ? null
            : Math.max(previous ?? 0, event.payload.countdownSecs),
        );
      },
    );

    // The call ended before the user answered.
    const unlistenCleared = listen("meeting-detection-cleared", () => {
      if (!active) return;
      setDetected(null);
      setCountdownFrom(null);
    });

    // The window changed shape. Usually because this panel asked it to, but not
    // always: hiding the panel grows it back, so that the next meeting does not
    // open onto a pill the user minimised three calls ago.
    const unlistenMinimized = listen<boolean>(
      "meeting-panel-minimized",
      (event) => {
        if (active) setMinimized(event.payload);
      },
    );

    return () => {
      active = false;
      void unlistenStarting.then((fn) => fn());
      void unlistenStartFailed.then((fn) => fn());
      void unlistenStatus.then((fn) => fn());
      void unlistenSegment.then((fn) => fn());
      void unlistenActivity.then((fn) => fn());
      void unlistenRefined.then((fn) => fn());
      void unlistenMention.then((fn) => fn());
      void unlistenSummarizing.then((fn) => fn());
      void unlistenFinal.then((fn) => fn());
      void unlistenFinalFailed.then((fn) => fn());
      void unlistenTitle.then((fn) => fn());
      void unlistenTitlePending.then((fn) => fn());
      void unlistenAutoEnded.then((fn) => fn());
      void unlistenDetected.then((fn) => fn());
      void unlistenCleared.then((fn) => fn());
      void unlistenMinimized.then((fn) => fn());
    };
  }, [adoptMeeting, adoptStatusIdentity, clearTranscript, refreshTranscript]);

  // Capture starting resolves the prompt either way.
  useEffect(() => {
    if (status?.active) {
      setDetected(null);
      setCountdownFrom(null);
    }
  }, [status?.active]);

  // The indicator appearing grows the content too, so it follows the live edge
  // on the same terms a new line does.
  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [segments, activity]);

  // A summary is one of the few things worth interrupting the live edge for:
  // the user is waiting for it, and it renders below a transcript they are
  // usually scrolled away from — so without this it arrived off-screen and
  // looked like nothing had happened.
  useEffect(() => {
    if (!summary) return;
    const scroller = scrollRef.current;
    const node = summaryRef.current;
    if (!scroller || !node) return;
    // Reading takes longer than the next line takes to arrive, so following the
    // live edge stops until the user scrolls back down themselves.
    stickToBottom.current = false;
    scroller.scrollTo({
      top: Math.max(0, node.offsetTop - 8),
      behavior: "smooth",
    });
  }, [summary]);

  // Transient confirmations clear themselves; the panel is too small to spend
  // a line on a message the user has already read.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (flashKey === null) return;
    const timer = window.setTimeout(() => setFlashKey(null), CITE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  useEffect(() => {
    try {
      localStorage.setItem(PANE_STORAGE_KEY, paneTab);
    } catch {
      // Storage can be unavailable; the tab simply isn't remembered.
    }
  }, [paneTab]);

  const active = (status?.active ?? false) && !pending.ending;
  const paused = pending.paused ?? status?.paused ?? false;
  // Capture is over but queued audio is still being transcribed. Lines keep
  // arriving, so the panel says so rather than looking like it has stalled.
  const draining = status?.draining ?? false;
  const startedAt = status?.startedAt ?? null;

  // A meeting the panel is still showing, with capture over. Not a separate
  // flag: holding one would need clearing on every path that adopts or drops a
  // meeting, and this is exactly equivalent.
  const finished = !active && !pending.starting && meetingId !== null;

  // The live edge. Gated on capture as well as the payload so a dropped final
  // event — the app quitting mid-meeting, a panel reopened onto a stale state —
  // cannot leave a transcript with dots pulsing under it forever.
  const talking = activity.mic || activity.system;
  const showActivity =
    (active || draining) && (talking || activity.pending > 0);

  // Elapsed *captured* time. Recomputed from the start timestamp on every tick
  // rather than incremented, so it stays correct across a sleep or a missed
  // frame, and with paused time subtracted so it agrees with the timestamps
  // beside each line — those count audio frames, which stop while paused.
  //
  // The ticker stops while paused, which also freezes the display at the right
  // value: `pausedMs` only reaches this window on a status event, so ticking
  // would count the pause twice over. Left frozen once capture ends too, where
  // it reads as the meeting's final length, and reset by the next meeting.
  const pausedMs = status?.pausedMs ?? 0;
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () =>
      setElapsed(Math.max(0, Date.now() / 1000 - startedAt - pausedMs / 1000));
    tick();
    if (!active || paused) return;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, active, paused, pausedMs]);

  // ---- Workspace -----------------------------------------------------------

  const openPane = useCallback(
    (tab: PaneTab) => {
      setPaneTab(tab);
      if (notesCollapsed) {
        setNotesCollapsed(false);
        void commands.setMeetingNotesLayout(split, false);
      }
    },
    [notesCollapsed, split],
  );

  const handleAddToNotes = useCallback((text: string) => {
    notesRef.current?.appendToNotes(text);
  }, []);

  // A citation: bring the transcript to the card that moment falls in, and
  // light it. The clock in an answer is floored to the second, so the card
  // wanted is the last one starting at or before the end of that second.
  const handleCite = useCallback(
    (ms: number) => {
      const target = [...blocks]
        .reverse()
        .find((block) => block.startMs <= ms + 999);
      const block = target ?? blocks[0];
      if (!block) return;
      const node = blockRefs.current.get(block.key);
      const scroller = scrollRef.current;
      if (!node || !scroller) return;
      stickToBottom.current = false;
      setDetached(true);
      scroller.scrollTo({
        top: Math.max(0, node.offsetTop - scroller.clientHeight / 3),
        behavior: "smooth",
      });
      setFlashKey(block.key);
    },
    [blocks],
  );

  // ⌘K: straight to the question box, from anywhere in the panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPane("ask");
        askRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPane]);

  // ---- Transcript interactions ----------------------------------------------

  const jumpToLive = () => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottom.current = true;
    setDetached(false);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  const handleTranscriptMouseUp = () => {
    // Read after the browser has finished updating the selection.
    requestAnimationFrame(() => {
      const picked = window.getSelection();
      const text = picked?.toString().trim() ?? "";
      const scroller = scrollRef.current;
      const root = rootRef.current;
      if (
        !picked ||
        picked.rangeCount === 0 ||
        text.length < 3 ||
        !scroller ||
        !root ||
        !scroller.contains(picked.anchorNode)
      ) {
        setSelection(null);
        return;
      }
      const rect = picked.getRangeAt(0).getBoundingClientRect();
      const frame = root.getBoundingClientRect();
      setSelection({
        text,
        top: Math.max(4, rect.top - frame.top - 34),
        left: Math.min(
          frame.width - 120,
          Math.max(8, rect.left - frame.left + rect.width / 2 - 56),
        ),
      });
    });
  };

  const askAboutSelection = () => {
    if (!selection) return;
    const text = selection.text;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    openPane("ask");
    askRef.current?.askAbout(text);
  };

  // ---- Commands -------------------------------------------------------------

  const handleStartMeeting = async () => {
    setError(null);
    setPending({ starting: true });
    const result = await commands.startMeeting(null);
    if (result.status === "error") {
      setPending({});
      setError(result.error);
    }
    // On success the status event clears `pending` and brings the transcript.
  };

  const handleEndMeeting = async () => {
    // `stop_meeting` tears capture down and returns; the queued backlog is
    // drained on its own thread and reported as `draining`. The optimistic flag
    // only has to cover the round trip now, not the transcription.
    setPending((previous) => ({ ...previous, ending: true }));
    const result = await commands.stopMeeting();
    if (result.status === "error") {
      setPending({});
      setError(result.error);
    }
    // The panel stays open on purpose: the wrap-up summary lands here, and the
    // user still wants to read back, ask about it and export.
  };

  const handleTogglePause = async () => {
    const next = !paused;
    setPending((previous) => ({ ...previous, paused: next }));
    const result = await commands.setMeetingPaused(next);
    if (result.status === "error") {
      setPending((previous) => ({ ...previous, paused: undefined }));
      setError(result.error);
    }
  };

  const handleExport = async () => {
    if (!meetingId) return;
    setError(null);

    // The save dialog is a plugin call and can reject outright — a panel that
    // cannot present a sheet, a revoked permission. Unhandled, that is a silent
    // dead button.
    let path: string | null = null;
    try {
      path = await saveDialog({
        defaultPath: suggestedFileName(
          meetingTitle ?? t("meeting.panel.title"),
        ),
        filters: [
          { name: t("meeting.panel.exportFilter"), extensions: ["md"] },
        ],
      });
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!path) return;

    setPending((previous) => ({ ...previous, exporting: true }));
    const result = await commands.exportMeetingToFile(meetingId, path, "md");
    setPending((previous) => ({ ...previous, exporting: undefined }));
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    setNotice(
      t("meeting.panel.exported", { name: path.split("/").pop() ?? path }),
    );
  };

  /// Transcript, notes and summary onto the clipboard — the far more common
  /// thing than a file: pasting the wrap-up into the thread you were about to
  /// send anyway.
  const handleCopy = async () => {
    if (!meetingId) return;
    setError(null);
    setPending((previous) => ({ ...previous, copying: true }));
    const result = await commands.exportMeetingText(meetingId, true);
    setPending((previous) => ({ ...previous, copying: undefined }));
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.data);
    } catch (e) {
      setError(String(e));
      return;
    }
    setNotice(t("meeting.panel.copied"));
  };

  const persistLayout = useCallback((nextSplit: number, collapsed: boolean) => {
    void commands.setMeetingNotesLayout(nextSplit, collapsed);
  }, []);

  const handleToggleCollapsed = () => {
    const next = !notesCollapsed;
    setNotesCollapsed(next);
    persistLayout(split, next);
  };

  // Pointer events with capture, rather than mouse events: the divider is a few
  // pixels tall, and without capture a fast drag leaves the element and drops
  // the gesture halfway down the panel.
  const handleDividerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingSplit.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleDividerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSplit.current) return;
    const node = splitRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0) return;
    setSplit(clampSplit((event.clientY - rect.top) / rect.height));
  };

  const handleDividerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingSplit.current) return;
    draggingSplit.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persistLayout(split, notesCollapsed);
  };

  // Arrow keys move the divider a line at a time — a control only a mouse can
  // reach is not a control.
  const handleDividerKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowUp" ? -0.04 : event.key === "ArrowDown" ? 0.04 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = clampSplit(split + step);
    setSplit(next);
    persistLayout(next, notesCollapsed);
  };

  // NSPanel: `getCurrentWindow().hide()` from the webview does not reliably
  // hide a panel, so closing goes through the same main-thread path that
  // created it.
  const handleClose = () => {
    void commands.hideMeetingPanel();
  };

  // Applied locally first, like every other control here: the window resize is
  // a main-thread hop away and the face has to change with the frame, not a
  // beat after it. The event that follows carries the same value.
  const handleMinimize = () => {
    setMinimized(true);
    void commands.setMeetingPanelMinimized(true);
  };

  const handleRestore = () => {
    setMinimized(false);
    void commands.setMeetingPanelMinimized(false);
  };

  const handleZoom = () => {
    void commands.toggleMeetingPanelZoom();
  };

  const commitTitle = async () => {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (!meetingId || next === (meetingTitle ?? "")) return;
    // A cleared name hands naming back to Ghostly; the backend answers with
    // the placeholder that replaces it.
    if (next) {
      setMeetingTitle(next);
      setTitleSource("user");
    }
    const result = await commands.setMeetingTitle(meetingId, next);
    if (result.status === "error") {
      setError(result.error);
      return;
    }
    setMeetingTitle(result.data);
    setTitleSource(next ? "user" : "default");
  };

  const handleSuggestTitle = async () => {
    if (!meetingId) return;
    setTitleDraft(null);
    setNaming(true);
    const result = await commands.generateMeetingTitle(meetingId);
    setNaming(false);
    if (result.status === "error") setError(result.error);
    // Success arrives as `meeting-title`, which every window hears.
  };

  const title = meetingTitle ?? t("meeting.panel.title");
  const showDuration = startedAt !== null || elapsed > 0;
  const hasMeeting = meetingId !== null || active;
  const startedLabel =
    startedAt !== null
      ? new Date(startedAt * 1000).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    // Opaque, with no `backdrop-blur`. WebKit does not clip a backdrop filter
    // to its element's `border-radius`, so the blurred layer painted as a
    // square and the panel's corners read as square no matter what radius the
    // container carried.
    //
    // The radius has to follow the shape the window is actually in: the mini
    // player is a pill, and `meetings::panel` rounds the *window* to match.
    //
    // `@container` so the title bar can drop its wordmark when the panel is
    // narrow, rather than squeezing the controls that matter.
    <div
      ref={rootRef}
      className={`@container relative flex h-full w-full flex-col overflow-hidden bg-surface-1 text-text shadow-2xl ${
        minimized ? "rounded-[20px]" : "rounded-[14px]"
      }`}
    >
      {minimized && (
        <MiniPlayer
          platform={platform}
          active={active}
          paused={paused}
          clock={showDuration ? formatDuration(elapsed) : null}
          onRestore={handleRestore}
        />
      )}

      {/* Hidden rather than unmounted. The notepad holds text that has not been
          written to disk yet, Ask may be mid-answer, and the transcript holds a
          scroll position the user chose. Minimising must cost none of them.
          `contents` keeps the children as flex items of the panel. */}
      <div className={minimized ? "hidden" : "contents"}>
        {/* The title bar, and the only way to move an undecorated panel.

          Every child is transparent to the mouse, so the drag target is always
          this div — Tauri's drag region tests `event.target`, which over the
          logo is a `<path>` deep inside the SVG. Buttons are exempted by a
          descendant selector, which survives nesting.

          It carries the transport: how long, pause, end. One control per state
          carries a fill or a tint — End while live, New meeting after — and the
          rest are quiet. */}
        <div
          data-tauri-drag-region
          className="relative flex h-9 shrink-0 cursor-grab select-none items-center gap-2 border-b border-hairline bg-surface-2 pl-3 pr-2 [&>*]:pointer-events-none [&_button]:pointer-events-auto active:cursor-grabbing"
        >
          <TrafficLights
            onClose={handleClose}
            onMinimize={handleMinimize}
            onZoom={handleZoom}
          />

          <GhostlyMark className="ml-1 hidden h-[14px] w-auto shrink-0 text-accent @min-[300px]:block" />
          <span className="hidden truncate text-[11px] font-semibold tracking-[0.09em] text-text-subtle @min-[380px]:inline">
            {t("meeting.panel.brand")}
          </span>

          <span className="flex-1 self-stretch" />

          {(active || showDuration) && (
            <div
              title={
                active && paused
                  ? t("meeting.panel.pausedNotice")
                  : t("meeting.panel.durationHint")
              }
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[3px] ${
                active && !paused ? "bg-danger/10" : "bg-fill-2"
              }`}
            >
              <span className="relative flex h-[6px] w-[6px]">
                {active && !paused && (
                  <span className="absolute inset-0 animate-ping rounded-full bg-danger/60" />
                )}
                <span
                  className={`relative h-[6px] w-[6px] rounded-full ${
                    active && !paused
                      ? "bg-danger"
                      : active
                        ? "bg-warning"
                        : "bg-text-faint"
                  }`}
                />
              </span>
              <span
                className={`text-[10.5px] font-semibold tabular-nums ${
                  active && !paused ? "text-danger" : "text-text-muted"
                }`}
              >
                {showDuration
                  ? formatDuration(elapsed)
                  : t("meeting.panel.liveLabel")}
              </span>
            </div>
          )}

          {pending.ending ? (
            <PanelButton variant="ghost" disabled>
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("meeting.panel.ending")}
            </PanelButton>
          ) : active ? (
            <>
              <PanelButton
                variant="icon"
                onClick={() => void handleTogglePause()}
                title={
                  paused ? t("meeting.panel.resume") : t("meeting.panel.pause")
                }
                aria-label={
                  paused ? t("meeting.panel.resume") : t("meeting.panel.pause")
                }
              >
                {paused ? (
                  <Play className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <Pause className="h-3.5 w-3.5 fill-current" />
                )}
              </PanelButton>
              <PanelButton
                variant="danger"
                onClick={() => void handleEndMeeting()}
                title={t("meeting.panel.endMeeting")}
              >
                <span className="h-[7px] w-[7px] rounded-[2px] bg-current" />
                {t("meeting.panel.end")}
              </PanelButton>
            </>
          ) : finished ? (
            <>
              <PanelButton
                variant="icon"
                onClick={() => void handleCopy()}
                disabled={pending.copying || segments.length === 0}
                title={t("meeting.panel.copyAll")}
                aria-label={t("meeting.panel.copyAll")}
              >
                <Copy className="h-3.5 w-3.5" />
              </PanelButton>
              <PanelButton
                variant="icon"
                onClick={() => void handleExport()}
                disabled={pending.exporting || segments.length === 0}
                title={t("meeting.panel.exportHint")}
                aria-label={t("meeting.panel.exportHint")}
              >
                <Download className="h-3.5 w-3.5" />
              </PanelButton>
              <PanelButton
                variant="primary"
                onClick={() => void handleStartMeeting()}
                disabled={pending.starting}
                title={t("meeting.panel.startNewMeeting")}
              >
                <Plus className="h-3 w-3" strokeWidth={2.5} />
                <span className="hidden @min-[300px]:inline">
                  {t("meeting.panel.newMeeting")}
                </span>
              </PanelButton>
            </>
          ) : null}
        </div>

        {/* The meeting's identity: where it is, what it is called, and what
          the capture is doing that the user needs to know. Absent before the
          first meeting, so a panel opened by the detection prompt is just the
          prompt rather than a stack of empty chrome. */}
        {hasMeeting && (
          <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-3 py-2">
            <PlatformLogo platform={platform} size={30} />

            <div className="min-w-0 flex-1">
              {titleDraft !== null ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => void commitTitle()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitTitle();
                      if (e.key === "Escape") setTitleDraft(null);
                    }}
                    placeholder={t("meeting.panel.titlePlaceholder")}
                    className="min-w-0 flex-1 rounded-md bg-surface-2 px-1.5 py-[3px] text-[13px] font-semibold outline-none ring-2 ring-accent/35"
                  />
                  <button
                    type="button"
                    // Fires before the input's blur commits the draft.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handleSuggestTitle()}
                    disabled={segments.length === 0}
                    title={t("meeting.panel.suggestTitle")}
                    aria-label={t("meeting.panel.suggestTitle")}
                    className="shrink-0 rounded-md p-1 text-accent transition-colors duration-150 hover:bg-accent/12 disabled:opacity-40"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={!meetingId}
                    onClick={() => setTitleDraft(meetingTitle ?? "")}
                    title={
                      titleSource === "ai"
                        ? t("meeting.panel.titleAiHint")
                        : t("meeting.panel.renameMeetingHint")
                    }
                    className="min-w-0 shrink truncate text-left text-[13px] font-semibold leading-tight"
                  >
                    <span
                      key={titleRevision}
                      className={`${naming ? "shimmer-text" : ""} ${
                        titleRevision > 0 ? "title-reveal" : ""
                      }`}
                    >
                      {title}
                    </span>
                  </button>
                  {(naming || titleSource === "ai") && (
                    <Sparkles
                      className={`h-[11px] w-[11px] shrink-0 text-accent ${
                        naming ? "animate-pulse" : ""
                      }`}
                      aria-label={
                        naming
                          ? t("meeting.panel.titleNaming")
                          : t("meeting.panel.titleAiHint")
                      }
                    />
                  )}
                  {meetingId && (
                    <button
                      type="button"
                      onClick={() => setTitleDraft(meetingTitle ?? "")}
                      title={t("meeting.panel.renameMeetingHint")}
                      aria-label={t("meeting.panel.renameMeetingHint")}
                      // Always visible, never a hover reveal: nothing else says
                      // the name is editable, and a control you have to find by
                      // accident is a control nobody finds.
                      className="shrink-0 rounded p-0.5 text-text-faint transition-colors duration-150 hover:bg-fill-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      <Pencil className="h-[10px] w-[10px]" aria-hidden />
                    </button>
                  )}
                </div>
              )}

              <div className="mt-[2px] flex min-w-0 items-center gap-1.5 text-[10.5px] text-text-subtle">
                {platform && <span className="truncate">{platform}</span>}
                {platform && startedLabel && (
                  <span className="text-text-faint" aria-hidden>
                    ·
                  </span>
                )}
                {startedLabel && (
                  <span className="shrink-0 tabular-nums">
                    {t("meeting.panel.startedAt", { time: startedLabel })}
                  </span>
                )}
                {/* States, not news: badges, with the sentence on the tooltip. */}
                {active && paused && (
                  <span
                    title={t("meeting.panel.pausedNotice")}
                    className="shrink-0 rounded-full bg-warning/15 px-1.5 py-[1px] text-[10px] font-medium text-warning"
                  >
                    {t("meeting.panel.pausedBadge")}
                  </span>
                )}
                {active && !paused && !status?.systemAudioActive && (
                  <span
                    title={t("meeting.panel.micOnly")}
                    className="shrink-0 rounded-full bg-warning/15 px-1.5 py-[1px] text-[10px] font-medium text-warning"
                  >
                    {t("meeting.panel.micOnlyBadge")}
                  </span>
                )}
                {draining && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-text-subtle">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    {t("meeting.panel.finishing")}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {detected && !active && (
          <div className="animate-rise mx-2.5 mt-2.5 shrink-0 overflow-hidden rounded-[13px] bg-accent/[0.08] ring-1 ring-accent/20">
            <div className="flex items-start gap-2.5 p-3 pb-2">
              <PlatformLogo
                platform={detected.platform ?? detected.displayName}
                size={30}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-semibold text-text">
                  {t("meeting.detected.title", {
                    app: detected.platform ?? detected.displayName,
                  })}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-[1.45] text-text-muted">
                  {detected.countdownSecs !== null
                    ? t("meeting.detected.startingIn", {
                        seconds: detected.countdownSecs,
                      })
                    : t("meeting.detected.prompt")}
                </p>
              </div>
            </div>
            {detected.countdownSecs !== null && countdownFrom && (
              <div className="mx-3 h-[3px] overflow-hidden rounded-full bg-accent/15">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
                  style={{
                    width: `${Math.max(0, ((detected.countdownSecs - 1) / countdownFrom) * 100)}%`,
                  }}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-2">
              {detected.countdownSecs === null && (
                <PanelButton
                  variant="primary"
                  onClick={() => {
                    setDetected(null);
                    void commands.acceptDetectedMeeting();
                  }}
                >
                  {t("meeting.detected.start")}
                </PanelButton>
              )}
              <PanelButton
                onClick={() => {
                  setDetected(null);
                  setCountdownFrom(null);
                  commands.dismissDetectedMeeting();
                }}
              >
                {t("meeting.detected.cancel")}
              </PanelButton>
              <button
                type="button"
                onClick={() => {
                  setDetected(null);
                  setCountdownFrom(null);
                  void commands.neverAutoConnectApp(
                    detected.bundleId,
                    detected.displayName,
                  );
                }}
                className="ml-auto text-[10.5px] text-text-subtle transition-colors duration-150 hover:text-text"
              >
                {t("meeting.detected.never", { app: detected.displayName })}
              </button>
            </div>
          </div>
        )}

        {mention && (
          <div className="animate-rise mx-2.5 mt-2.5 flex shrink-0 items-start gap-2.5 rounded-[13px] bg-accent/[0.10] p-3 ring-1 ring-accent/25">
            <span className="mt-[1px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-canvas">
              <BellRing className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-accent-bright">
                {t("meeting.panel.mentionHeading")}
              </p>
              <p className="mt-0.5 break-words text-[12px] leading-[1.45] text-text">
                {mention}
              </p>
              <button
                type="button"
                onClick={() => {
                  setMention(null);
                  openPane("ask");
                  askRef.current?.askAbout(mention);
                }}
                className="mt-1.5 inline-flex max-w-full items-center gap-1 rounded-md bg-accent/15 px-2 py-[3px] text-[11px] font-medium text-accent-bright transition-colors duration-150 hover:bg-accent/25"
              >
                <Sparkles className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {t("meeting.panel.mentionAsk")}
                </span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setMention(null)}
              aria-label={t("meeting.panel.dismiss")}
              className="shrink-0 rounded-md p-1 text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* The split. `flexGrow` rather than percentage heights: the two panes
          have to share whatever the window is, and a percentage inside a flex
          column resolves against a height the divider is itself changing. */}
        <div ref={splitRef} className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            style={
              notesCollapsed
                ? undefined
                : { flexGrow: split, flexShrink: 1, flexBasis: 0 }
            }
            onScroll={() => {
              const node = scrollRef.current;
              if (!node) return;
              const distanceFromBottom =
                node.scrollHeight - node.scrollTop - node.clientHeight;
              stickToBottom.current = distanceFromBottom < 48;
              setDetached(distanceFromBottom >= 48);
              setSelection(null);
            }}
            onMouseUp={handleTranscriptMouseUp}
            // `log` rather than a bare live region: it tells a screen reader
            // this is an append-only stream, so each new card is announced as it
            // lands instead of the whole transcript being re-read. Polite, since
            // a meeting transcript must never interrupt the meeting.
            role="log"
            aria-live="polite"
            aria-label={t("meeting.panel.transcriptLabel")}
            className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
          >
            {/* The placeholder gives way the moment there is activity to show —
            it is absolutely positioned, so leaving it up would stack the
            "listening" copy on top of the indicator. */}
            {segments.length === 0 && !showActivity ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <span
                  className={`flex h-14 w-14 items-center justify-center rounded-full bg-fill-1 ring-1 ring-hairline ${
                    pending.starting || (active && !paused)
                      ? "animate-pulse-ring"
                      : ""
                  }`}
                >
                  <GhostlyMark
                    className={`h-7 w-auto ${
                      active || pending.starting
                        ? "text-accent"
                        : "text-text-faint"
                    }`}
                  />
                </span>
                {pending.starting ? (
                  <p className="text-[12px] text-text-subtle">
                    {t("meeting.panel.starting")}
                  </p>
                ) : active ? (
                  <p className="text-[12px] text-text-subtle">
                    {paused
                      ? t("meeting.panel.pausedNotice")
                      : t("meeting.panel.listening")}
                  </p>
                ) : meetingId ? (
                  <p className="text-[12px] text-text-subtle">
                    {t("meeting.panel.notCapturing")}
                  </p>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-[13px] font-semibold text-text">
                      {t("meeting.panel.idleTitle")}
                    </p>
                    <p className="max-w-[260px] text-[11.5px] leading-[1.5] text-text-subtle">
                      {t("meeting.panel.idleBody")}
                    </p>
                    {!detected && (
                      <PanelButton
                        variant="primary"
                        className="mt-1 h-[28px] px-3.5 text-[12px]"
                        onClick={() => void handleStartMeeting()}
                      >
                        <span className="h-[7px] w-[7px] rounded-full bg-current" />
                        {t("meeting.panel.startMeeting")}
                      </PanelButton>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* One card per block of continuous speech.

               No name, no permanent timestamp: what is worth reading is what
               was said. The card carries the job the speaker label used to do —
               saying where a thought ended — without claiming anything that
               might be false. `w-fit` keeps a three-word aside a small pill.

               The clock stays on hover, since finding a moment again is the
               one thing the metadata was genuinely good for — and it is where
               a citation from Ask lands, lit for a moment so the eye finds it. */
              blocks.map((block) => (
                <div
                  key={block.key}
                  ref={(node) => {
                    if (node) blockRefs.current.set(block.key, node);
                    else blockRefs.current.delete(block.key);
                  }}
                  className="group relative mb-1.5 last:mb-0"
                >
                  <div
                    className={`w-fit max-w-full rounded-[13px] px-3 py-2 transition-[background-color,box-shadow] duration-300 ${
                      flashKey === block.key
                        ? "cite-flash bg-accent/15 ring-1 ring-accent/50"
                        : "bg-fill-1"
                    }`}
                  >
                    <p className="break-words text-[13px] leading-[1.55] text-text-muted">
                      {blockText(block)}
                    </p>
                  </div>
                  <span
                    className={`pointer-events-none absolute right-1 top-1 rounded bg-surface-3 px-1 text-[10px] tabular-nums text-text-faint transition-opacity duration-150 group-hover:opacity-100 ${
                      flashKey === block.key ? "opacity-100" : "opacity-0"
                    }`}
                  >
                    {formatClock(block.startMs)}
                  </span>
                </div>
              ))
            )}

            {/* Somebody is mid-sentence, or the model is still catching up. */}
            {showActivity && (
              <div
                aria-live="polite"
                aria-label={
                  talking
                    ? t("meeting.panel.someoneSpeaking")
                    : t("meeting.panel.transcribing")
                }
                className="mt-1.5 flex items-center gap-2"
              >
                <TypingDots />
                {!talking && (
                  <span className="truncate text-[11px] text-text-faint">
                    {t("meeting.panel.transcribing")}
                  </span>
                )}
              </div>
            )}

            {summary && (
              <SummaryCard
                innerRef={summaryRef}
                heading={t("meeting.panel.finalSummaryHeading")}
                body={summary}
                onCite={handleCite}
                onAddToNotes={handleAddToNotes}
                onDismiss={() => setSummary(null)}
              />
            )}

            {summarizing && !summary && (
              <div className="animate-rise mt-3 flex items-center justify-center gap-1.5 text-[11px] text-text-subtle">
                <Sparkles className="h-3 w-3 animate-pulse text-accent" />
                <span className="shimmer-text">
                  {t("meeting.panel.wrappingUp")}
                </span>
              </div>
            )}

            {autoEnded && (
              <p className="animate-rise mt-2 rounded-lg bg-fill-2 px-2.5 py-1.5 text-[11px] text-text-subtle">
                {t("meeting.panel.autoEnded")}
              </p>
            )}

            {error && (
              <div className="animate-rise mt-2 flex items-start gap-2 rounded-lg bg-danger/10 px-2.5 py-1.5">
                <p className="min-w-0 flex-1 text-[11px] leading-[1.45] text-danger">
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  aria-label={t("meeting.panel.dismiss")}
                  className="shrink-0 text-danger/70 transition-colors duration-150 hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {/* Back to the live edge, once the user has scrolled away from it. */}
          {detached && (active || draining) && segments.length > 0 && (
            <button
              type="button"
              onClick={jumpToLive}
              style={
                notesCollapsed
                  ? { bottom: 44 }
                  : { bottom: `calc(${(1 - split) * 100}% + 12px)` }
              }
              className="animate-rise absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-surface-3 px-2.5 py-1 text-[11px] font-medium text-text shadow-lg ring-1 ring-hairline-strong transition-colors duration-150 hover:bg-surface-2"
            >
              <ArrowDown className="h-3 w-3" />
              {t("meeting.panel.jumpToLive")}
            </button>
          )}

          {!notesCollapsed && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("meeting.notes.resize")}
              aria-valuenow={Math.round(split * 100)}
              tabIndex={0}
              onPointerDown={handleDividerDown}
              onPointerMove={handleDividerMove}
              onPointerUp={handleDividerUp}
              onPointerCancel={handleDividerUp}
              onKeyDown={handleDividerKey}
              onDoubleClick={() => {
                setSplit(DEFAULT_SPLIT);
                persistLayout(DEFAULT_SPLIT, notesCollapsed);
              }}
              title={t("meeting.notes.resizeHint")}
              className="group flex h-[7px] shrink-0 cursor-row-resize items-center justify-center border-t border-hairline bg-surface-2/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
            >
              <span className="h-[2px] w-7 rounded-full bg-hairline-strong transition-colors duration-150 group-hover:bg-accent/60" />
            </div>
          )}

          {/* The workspace: Notes or Ask, under one tab bar. Both panes stay
            mounted — a hidden notepad keeps its unsaved text, a hidden Ask keeps
            streaming — and each renders its own controls into the bar's slot
            while it is the tab showing. */}
          <section
            style={
              notesCollapsed
                ? undefined
                : { flexGrow: 1 - split, flexShrink: 1, flexBasis: 0 }
            }
            className={`flex min-h-0 flex-col overflow-hidden bg-surface-2/30 ${
              notesCollapsed ? "flex-none border-t border-hairline" : ""
            }`}
          >
            <div className="flex h-8 shrink-0 items-center gap-1.5 pl-1.5 pr-2">
              <button
                type="button"
                onClick={handleToggleCollapsed}
                title={
                  notesCollapsed
                    ? t("meeting.workspace.expand")
                    : t("meeting.workspace.collapse")
                }
                aria-label={
                  notesCollapsed
                    ? t("meeting.workspace.expand")
                    : t("meeting.workspace.collapse")
                }
                aria-expanded={!notesCollapsed}
                className="rounded p-1 text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {notesCollapsed ? (
                  <ChevronUp className="h-3 w-3" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3" aria-hidden />
                )}
              </button>

              <div
                role="tablist"
                className="flex shrink-0 items-center gap-0.5 rounded-lg bg-fill-2 p-[2px]"
              >
                {(["notes", "ask"] as const).map((tab) => {
                  const selected = paneTab === tab;
                  const Icon = tab === "notes" ? NotebookPen : Sparkles;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() =>
                        selected && !notesCollapsed ? undefined : openPane(tab)
                      }
                      title={
                        tab === "ask"
                          ? t("meeting.workspace.askHint")
                          : undefined
                      }
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-medium transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                        selected
                          ? "bg-surface-1 text-text shadow-sm"
                          : "text-text-subtle hover:text-text"
                      }`}
                    >
                      <Icon
                        className={`h-3 w-3 ${
                          selected && tab === "ask" ? "text-accent" : ""
                        }`}
                        aria-hidden
                      />
                      {t(`meeting.workspace.${tab}`)}
                    </button>
                  );
                })}
              </div>

              <span className="flex-1" />

              <div
                ref={setHeaderSlot}
                className="flex min-w-0 items-center justify-end gap-1"
              />
            </div>

            <NotesPane
              ref={notesRef}
              meetingId={meetingId}
              capturing={active || draining}
              finished={finished && !draining}
              hasTranscript={segments.length > 0}
              visible={paneTab === "notes"}
              expanded={!notesCollapsed}
              headerSlot={headerSlot}
            />
            <AskPane
              ref={askRef}
              meetingId={meetingId}
              live={active || draining}
              hasTranscript={segments.length > 0}
              visible={paneTab === "ask" && !notesCollapsed}
              headerSlot={headerSlot}
              onCite={handleCite}
              onAddToNotes={(text) => {
                handleAddToNotes(text);
                setNotice(t("meeting.ask.addedToNotes"));
              }}
              onExternalQuestion={() => openPane("ask")}
            />
          </section>
        </div>

        {/* "Ask about this", floating over a transcript selection. */}
        {selection && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={askAboutSelection}
            style={{ top: selection.top, left: selection.left }}
            className="animate-rise absolute z-20 flex items-center gap-1 rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-canvas shadow-lg shadow-accent/25 transition-colors duration-150 hover:bg-accent-bright"
          >
            <Sparkles className="h-3 w-3" />
            {t("meeting.panel.askAboutSelection")}
          </button>
        )}

        {/* Transient confirmations, as a toast over the panel's foot. */}
        {notice && (
          <div className="animate-rise pointer-events-none absolute bottom-3 left-1/2 z-30 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface-3 px-3 py-1.5 text-[11px] font-medium text-text shadow-xl ring-1 ring-hairline-strong">
            <Check className="h-3 w-3 shrink-0 text-success" />
            <span className="truncate">{notice}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default MeetingPanel;
