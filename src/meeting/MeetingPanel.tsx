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
import { Pencil } from "lucide-react";
import { usePanelTheme } from "./usePanelTheme";
import { NotesPane } from "./NotesPane";
import { MiniPlayer } from "./MiniPlayer";
import { TrafficLights } from "./TrafficLights";
import { GhostlyMark } from "@/components/icons/GhostlyMark";
import { commands } from "@/bindings";
import type { MeetingSegment, MeetingStatus } from "@/bindings";
import { groupIntoBlocks } from "@/lib/meetingBlocks";

/**
 * The floating live transcript, over the notepad.
 *
 * Design notes:
 * - Two panes, split by a draggable divider: the transcript is what the meeting
 *   is saying, the notepad is what you make of it. The split is remembered
 *   because it is a working preference, not a per-meeting decision — some
 *   people watch the transcript, some barely look at it.
 * - Auto-scroll sticks to the bottom but releases the moment the user scrolls
 *   up. Yanking someone back to the live edge while they are reading is the
 *   single most annoying thing a live transcript can do. The one exception is a
 *   summary arriving: the user pressed a button and is waiting for it, so the
 *   panel scrolls it into view and then stops following the live edge.
 * - The transcript reads as paragraphs, not as a chat log. It used to attribute
 *   and time-stamp every utterance, but "You" and "Participant" were never more
 *   than which audio lane the segment arrived on — two people sharing a
 *   microphone were one speaker, and the user's own voice echoing back off the
 *   call was a second one. A label that is wrong that often is worse than no
 *   label, so the transcript now shows the speech and leaves the guessing out.
 * - The transcript is deliberately NOT cleared when capture stops. The panel
 *   stays open afterwards so the user can read it and export it; wiping it on
 *   stop would destroy exactly that workflow. It *is* cleared when the next
 *   meeting starts — see `meeting-starting`.
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
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** `h:mm:ss` past the hour, `m:ss` below it. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedSecs = secs.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${paddedSecs}`
    : `${minutes}:${paddedSecs}`;
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
 * Flat by design: no borders, no fills at rest, no shadows. A footer of three
 * outlined pills reads as three competing decisions. Exactly one control per
 * state carries a fill — the thing you most likely came to press — and the rest
 * are quiet text that only take a background under the cursor.
 *
 * Shared so every control lands on the same height, radius and press feedback.
 */
const PanelButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger";
  }
> = ({ variant = "ghost", className = "", ...props }) => {
  // `shrink-0 whitespace-nowrap` is load-bearing, not tidiness. Flex children
  // shrink below their content by default, and the panel resizes down to 240pt:
  // the three-button finished state was being squeezed until each label spilled
  // out of its own padding box and ran across its neighbour. The buttons now
  // hold their width and the footer wraps instead.
  const base =
    "shrink-0 select-none whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] font-medium " +
    "transition-[background-color,color,opacity,transform] duration-150 " +
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
  const variants = {
    primary:
      "bg-accent text-canvas hover:bg-accent-bright active:bg-accent-deep",
    ghost: "text-text-muted hover:bg-fill-2 hover:text-text active:bg-fill-3",
    danger: "text-danger hover:bg-danger/10 active:bg-danger/15",
  };
  return (
    <button
      type="button"
      className={`${base} ${variants[variant]} ${className}`}
      {...props}
    />
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
  const [activity, setActivity] = useState<ActivityPayload>(IDLE_ACTIVITY);
  const [summaryHeading, setSummaryHeading] = useState("catchUpHeading");
  const [autoEnded, setAutoEnded] = useState(false);
  const [pending, setPending] = useState<Pending>({});

  // Held separately from `status.title`, which reverts to the default snapshot
  // the moment capture stops — the panel would otherwise forget the meeting's
  // name while still showing its transcript.
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  // `null` means "not editing"; the empty string is a legitimate draft.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // The meeting the panel is showing. Not `status.meetingId`: that goes null
  // the moment capture stops, while the panel deliberately keeps the finished
  // transcript on screen — and renaming it, exporting it or catching up on it
  // all still need an id. Cleared only when the next meeting begins.
  const [meetingId, setMeetingId] = useState<string | null>(null);

  // Share of the panel's height given to the transcript. The notepad takes the
  // rest. Loaded from settings on mount and written back when a drag ends —
  // per-pixel writes during the drag would hammer the settings store.
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [notesCollapsed, setNotesCollapsed] = useState(false);

  // Shrunk to the mini player. The window's geometry is Rust's business — see
  // `meetings::panel` — so this is only which of the two faces to draw, and the
  // backend is authoritative: it restores the panel whenever it is hidden, and
  // says so with `meeting-panel-minimized`.
  const [minimized, setMinimized] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
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
    setElapsed(0);
    stickToBottom.current = true;
  }, []);

  const refreshTranscript = useCallback(async (meetingId: string) => {
    const segmentsResult = await commands.getMeetingSegments(meetingId);
    // A meeting that ended while the query was in flight must not have the
    // next one's transcript written over it.
    if (meetingIdRef.current !== meetingId) return;
    if (segmentsResult.status === "ok") setSegments(segmentsResult.data);
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
        setMeetingTitle(current.title);
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
        if (next.meetingId) setMeetingTitle(next.title);
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

    const unlistenCatchUp = listen<SummaryPayload>(
      "meeting-catch-up",
      (event) => {
        if (!active) return;
        setSummaryHeading("catchUpHeading");
        setSummary(event.payload.body);
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
        setSummaryHeading("finalSummaryHeading");
        setSummary(event.payload.body);
      },
    );
    const unlistenFinalFailed = listen("meeting-final-summary-failed", () => {
      if (active) setSummarizing(false);
    });

    // Silence auto-end. Said out loud, because a meeting that ended without
    // anyone pressing anything otherwise reads as a crash.
    const unlistenAutoEnded = listen("meeting-auto-ended", () => {
      if (active) setAutoEnded(true);
    });

    const unlistenDetected = listen<DetectedPayload>(
      "meeting-detected",
      (event) => {
        if (active) setDetected(event.payload);
      },
    );

    // The call ended before the user answered.
    const unlistenCleared = listen("meeting-detection-cleared", () => {
      if (active) setDetected(null);
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
      void unlistenCatchUp.then((fn) => fn());
      void unlistenSummarizing.then((fn) => fn());
      void unlistenFinal.then((fn) => fn());
      void unlistenFinalFailed.then((fn) => fn());
      void unlistenAutoEnded.then((fn) => fn());
      void unlistenDetected.then((fn) => fn());
      void unlistenCleared.then((fn) => fn());
      void unlistenMinimized.then((fn) => fn());
    };
  }, [adoptMeeting, clearTranscript, refreshTranscript]);

  // Capture starting resolves the prompt either way.
  useEffect(() => {
    if (status?.active) setDetected(null);
  }, [status?.active]);

  // The indicator appearing grows the content too, so it follows the live edge
  // on the same terms a new line does.
  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [segments, activity]);

  // A summary is the one thing worth interrupting the live edge for: the user
  // pressed a button and is waiting for the answer, and it renders below a
  // transcript they are usually scrolled away from — so without this it arrived
  // off-screen and looked like nothing had happened.
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
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

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

  // The live edge. Someone talking outranks the queue: while a lane is open the
  // indicator is named, and once everyone has stopped it becomes an unattributed
  // "still transcribing" while the backlog clears.
  //
  // Gated on capture as well as the payload so a dropped final event — the app
  // quitting mid-meeting, a panel reopened onto a stale state — cannot leave a
  // transcript with dots pulsing under it forever.
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

  const handleCatchUp = async () => {
    setSummarizing(true);
    setError(null);
    const result = await commands.catchMeUp(meetingId);
    setSummarizing(false);
    if (result.status === "ok") setSummary(result.data);
    else setError(result.error);
  };

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
    // user still wants to read back, name speakers and export.
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
    // dead button, which is the failure mode this whole session has been about.
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

  /// Transcript, notes and summary onto the clipboard.
  ///
  /// Export writes a file, which is the right shape for keeping a meeting and
  /// the wrong one for the far more common thing: pasting the wrap-up into the
  /// thread you were about to send anyway. That needed a save dialog, a folder
  /// and then a trip to Finder.
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

  const handleToggleNotes = () => {
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

  // Arrow keys move the divider a line at a time — the panel is a window like
  // any other, and a control only a mouse can reach is not a control.
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
  // created it. Nothing to apply optimistically — the window itself is the
  // feedback — but it must not wait on anything either.
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
    const next = (titleDraft ?? "").trim();
    setTitleDraft(null);
    if (!meetingId || next === (meetingTitle ?? "")) return;
    setMeetingTitle(next || null);
    const result = await commands.setMeetingTitle(meetingId, next);
    if (result.status === "error") setError(result.error);
  };

  const title = meetingTitle ?? t("meeting.panel.title");
  const showDuration = startedAt !== null || elapsed > 0;

  return (
    // Opaque, with no `backdrop-blur`. WebKit does not clip a backdrop filter
    // to its element's `border-radius`, so the blurred layer painted as a
    // square and the panel's corners read as square no matter what radius the
    // container carried. At 95% opacity the blur was buying nothing anyway.
    //
    // The radius has to follow the shape the window is actually in: the mini
    // player is a pill, and `meetings::panel` rounds the *window* to match. The
    // two are drawn separately and the smaller of them wins, so a 14px root
    // inside a 20px window mask reads as a rounded rectangle, not a pill.
    <div
      className={`relative flex h-full w-full flex-col overflow-hidden bg-surface-1 text-text shadow-2xl ${
        minimized ? "rounded-[20px]" : "rounded-[14px]"
      }`}
    >
      {minimized && (
        <MiniPlayer
          active={active}
          paused={paused}
          clock={showDuration ? formatDuration(elapsed) : null}
          onRestore={handleRestore}
        />
      )}

      {/* Hidden rather than unmounted. The notepad holds text that has not been
          written to disk yet — including notes typed before any meeting exists,
          which live nowhere else — and the transcript holds a scroll position
          the user chose. Minimising must cost neither. `contents` keeps the
          children as flex items of the panel, so the layout is identical to
          having no wrapper at all. */}
      <div className={minimized ? "hidden" : "contents"}>
        {/* The title bar. Also the drag handle — the panel is undecorated, so
          this is the only way to move it.

          Every child is made transparent to the mouse, rather than repeating
          `data-tauri-drag-region` on each of them. Tauri's drag region is a
          `mousedown` listener that tests `event.target` for the attribute, and
          the target is the *deepest* element under the cursor — which over the
          logo is a `<path>` inside the SVG, not the SVG the attribute was on.
          So the strip had dead spots exactly where its contents were, which is
          most of it. With the contents transparent the target is always this
          div, and the whole bar drags.

          Buttons are exempted by a descendant selector rather than by
          `pointer-events-auto` on each one: `& button` outranks `& > *`, so the
          exemption survives being nested inside a group — which the window
          buttons are.

          It carries the brand rather than the meeting: the meeting's own name
          is editable, and a title bar you have to think about before grabbing
          is not a title bar. The name is on its own row below.

          It is surface-coloured, not a saturated accent bar. A solid purple
          block across the top made the panel read as a different application
          from the one it belongs to — the rest of Ghostly reserves the accent
          for the thing you are meant to press, and a title bar is never that.
          The ghost mark keeps the accent, which is enough to say whose window
          this is. */}
        <div
          data-tauri-drag-region
          className="relative flex h-8 shrink-0 cursor-grab select-none items-center gap-2 border-b border-hairline bg-surface-2 pl-3 pr-2.5 [&>*]:pointer-events-none [&_button]:pointer-events-auto active:cursor-grabbing"
        >
          <TrafficLights
            onClose={handleClose}
            onMinimize={handleMinimize}
            onZoom={handleZoom}
          />

          {/* Height only: the mark's viewBox is taller than it is wide, and a
            square box squashes the hem sweep it is named for. */}
          <GhostlyMark className="ml-1 h-[15px] w-auto shrink-0 text-accent" />
          <span className="truncate text-[11px] font-semibold tracking-[0.09em] text-text-subtle">
            {t("meeting.panel.brand")}
          </span>

          <span className="flex-1 self-stretch" />

          {(active || showDuration) && (
            <div
              title={t("meeting.panel.durationHint")}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-fill-2 px-2 py-[2px]"
            >
              <span
                className={`h-[5px] w-[5px] rounded-full ${
                  active && !paused
                    ? "animate-pulse bg-danger"
                    : active
                      ? "bg-text-faint"
                      : "bg-text-faint/50"
                }`}
              />
              <span className="text-[10px] font-medium tabular-nums text-text-muted">
                {showDuration
                  ? formatDuration(elapsed)
                  : t("meeting.panel.liveLabel")}
              </span>
            </div>
          )}
        </div>

        {/* The meeting's own identity: name, and whatever the capture is doing
          that the user needs to know about. Absent entirely before the first
          meeting, so a panel opened by the detection prompt is just the prompt
          rather than a stack of empty chrome.

          Untinted, now that the title bar above it is surface-coloured too —
          two stacked bars of the same fill would read as one confused strip of
          chrome. This row belongs to the content, so it takes the content's
          background and only the hairline separates them. */}
        {(meetingId !== null || active) && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1.5">
            <div className="min-w-0 flex-1">
              {titleDraft !== null ? (
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
                  className="w-full rounded-md bg-surface-2 px-1.5 py-[2px] text-[12px] font-medium outline-none ring-2 ring-accent/30"
                />
              ) : (
                <div className="flex min-w-0 items-center gap-1">
                  <span className="min-w-0 shrink truncate text-[12px] font-medium">
                    {title}
                  </span>
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
                      <Pencil className="h-[11px] w-[11px]" aria-hidden />
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Both of these used to be full sentences under the title, which
              cost a line of transcript each. They are states, not news, so
              they read as badges with the sentence on the tooltip. */}
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
              <span className="shrink-0 truncate text-[10px] text-text-subtle">
                {t("meeting.panel.finishing")}
              </span>
            )}
          </div>
        )}

        {detected && !active && (
          <div className="animate-rise shrink-0 bg-accent/10 px-3 py-2.5">
            <p className="text-[12px] font-medium text-text">
              {t("meeting.detected.title", { app: detected.displayName })}
            </p>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {detected.countdownSecs !== null
                ? t("meeting.detected.startingIn", {
                    seconds: detected.countdownSecs,
                  })
                : t("meeting.detected.prompt")}
            </p>
            <div className="mt-2 flex items-center gap-2">
              {detected.countdownSecs === null && (
                <PanelButton
                  variant="primary"
                  className="px-2.5 py-1 text-[11px]"
                  onClick={() => {
                    setDetected(null);
                    void commands.acceptDetectedMeeting();
                  }}
                >
                  {t("meeting.detected.start")}
                </PanelButton>
              )}
              <PanelButton
                className="px-2.5 py-1 text-[11px]"
                onClick={() => {
                  setDetected(null);
                  commands.dismissDetectedMeeting();
                }}
              >
                {t("meeting.detected.cancel")}
              </PanelButton>
              <button
                type="button"
                onClick={() => {
                  setDetected(null);
                  void commands.neverAutoConnectApp(
                    detected.bundleId,
                    detected.displayName,
                  );
                }}
                className="ml-auto text-[10px] text-text-subtle transition-colors duration-150 hover:text-text"
              >
                {t("meeting.detected.never", { app: detected.displayName })}
              </button>
            </div>
          </div>
        )}

        {mention && (
          <div className="animate-rise flex shrink-0 items-start gap-2 bg-accent/10 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-accent">
                {t("meeting.panel.mentionHeading")}
              </p>
              <p className="break-words text-[12px] text-text">{mention}</p>
            </div>
            <button
              type="button"
              onClick={() => setMention(null)}
              className="shrink-0 text-[11px] text-text-subtle transition-colors duration-150 hover:text-text"
            >
              {t("meeting.panel.dismiss")}
            </button>
          </div>
        )}

        {/* The split. `flexGrow` rather than percentage heights: the two panes
          have to share whatever the window is, and a percentage inside a flex
          column resolves against a height the divider is itself changing. */}
        <div ref={splitRef} className="flex min-h-0 flex-1 flex-col">
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
            }}
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
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
                <GhostlyMark
                  className={`h-8 w-auto text-text-faint ${
                    pending.starting || (active && !paused)
                      ? "animate-pulse"
                      : ""
                  }`}
                />
                <p className="text-[12px] text-text-subtle">
                  {pending.starting
                    ? t("meeting.panel.starting")
                    : active
                      ? t("meeting.panel.listening")
                      : t("meeting.panel.notCapturing")}
                </p>
              </div>
            ) : (
              /* One card per block of continuous speech.

               No name, no permanent timestamp: what is worth reading is what
               was said, and a column of "You / Participant / You" down the left
               edge was both noise and, half the time, wrong. But dropping the
               names left the blocks running together as one slab of prose with
               nothing to say where a thought ended. The card is what carries
               that now — it does the job the speaker label used to do, without
               claiming anything that might be false.

               `w-fit` so a card is only as wide as it needs to be: a three-word
               aside stays a small pill instead of a wide box with one word in
               it, which is what makes a page of these scan as a conversation.

               The clock stays available on hover, since finding a moment again
               is the one thing the metadata was genuinely good for. It is
               positioned against the row rather than the card, so beside a
               narrow card it sits in the empty space to its right. */
              blocks.map((block) => (
                <div
                  key={block.key}
                  className="group relative mb-1.5 last:mb-0"
                >
                  <div className="w-fit max-w-full rounded-[13px] bg-fill-1 px-3 py-2">
                    <p className="break-words text-[13px] leading-[1.55] text-text-muted">
                      {block.segments.map((segment) => segment.text).join(" ")}
                    </p>
                  </div>
                  <span className="pointer-events-none absolute right-1 top-1 rounded bg-surface-3 px-1 text-[10px] tabular-nums text-text-faint opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    {formatClock(block.startMs)}
                  </span>
                </div>
              ))
            )}

            {/* Somebody is mid-sentence, or the model is still catching up. Just
              the dots: the name that used to sit above them was the same lane
              guess the transcript has stopped making, and "someone is talking"
              is the whole of what this indicator knows. */}
            {showActivity && (
              <div
                aria-live="polite"
                aria-label={
                  talking
                    ? t("meeting.panel.someoneSpeaking")
                    : t("meeting.panel.transcribing")
                }
                className="flex items-center gap-2"
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
              <div
                ref={summaryRef}
                className="animate-rise mt-3 rounded-xl bg-accent/[0.08] p-3"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent">
                    {t(`meeting.panel.${summaryHeading}`)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSummary(null)}
                    className="shrink-0 text-[11px] text-text-subtle transition-colors duration-150 hover:text-text"
                  >
                    {t("meeting.panel.dismiss")}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.5] text-text-muted">
                  {summary}
                </pre>
              </div>
            )}

            {summarizing && !summary && (
              <p className="mt-3 text-center text-[11px] text-text-subtle">
                <span className="shimmer-text">
                  {t("meeting.panel.wrappingUp")}
                </span>
              </p>
            )}

            {autoEnded && (
              <p className="animate-rise mt-2 rounded-lg bg-fill-2 px-2 py-1.5 text-[11px] text-text-subtle">
                {t("meeting.panel.autoEnded")}
              </p>
            )}

            {notice && (
              <p className="animate-rise mt-2 rounded-lg bg-success/10 px-2 py-1.5 text-[11px] text-success">
                {notice}
              </p>
            )}

            {error && (
              <p className="animate-rise mt-2 rounded-lg bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
                {error}
              </p>
            )}
          </div>

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

          <NotesPane
            meetingId={meetingId}
            capturing={active || draining}
            finished={finished && !draining}
            hasTranscript={segments.length > 0}
            collapsed={notesCollapsed}
            onToggleCollapsed={handleToggleNotes}
            style={{ flexGrow: 1 - split, flexShrink: 1, flexBasis: 0 }}
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-hairline bg-surface-2/40 px-3 py-2">
          {pending.ending ? (
            <PanelButton disabled>{t("meeting.panel.ending")}</PanelButton>
          ) : active ? (
            <>
              <PanelButton
                variant="primary"
                onClick={() => void handleCatchUp()}
                disabled={summarizing || segments.length === 0}
              >
                {summarizing
                  ? t("meeting.panel.catchingUp")
                  : t("meeting.panel.catchMeUp")}
              </PanelButton>
              <PanelButton onClick={() => void handleTogglePause()}>
                {paused ? t("meeting.panel.resume") : t("meeting.panel.pause")}
              </PanelButton>
              <PanelButton
                variant="danger"
                className="ml-auto"
                onClick={() => void handleEndMeeting()}
              >
                {t("meeting.panel.endMeeting")}
              </PanelButton>
            </>
          ) : finished ? (
            // The meeting is over. "Where were we?" and Pause have nothing left
            // to act on, so the row becomes the three things you actually do with
            // a finished transcript.
            <>
              <PanelButton
                variant="primary"
                onClick={() => void handleStartMeeting()}
                disabled={pending.starting}
              >
                {t("meeting.panel.startNewMeeting")}
              </PanelButton>
              <PanelButton
                onClick={() => void handleCopy()}
                disabled={pending.copying || segments.length === 0}
              >
                {pending.copying
                  ? t("meeting.panel.copying")
                  : t("meeting.panel.copy")}
              </PanelButton>
              <PanelButton
                onClick={() => void handleExport()}
                disabled={pending.exporting || segments.length === 0}
              >
                {pending.exporting
                  ? t("meeting.panel.exporting")
                  : t("meeting.panel.export")}
              </PanelButton>
              <PanelButton className="ml-auto" onClick={handleClose}>
                {t("meeting.panel.close")}
              </PanelButton>
            </>
          ) : (
            <PanelButton
              variant="primary"
              onClick={() => void handleStartMeeting()}
              disabled={pending.starting}
            >
              {pending.starting
                ? t("meeting.panel.starting")
                : t("meeting.panel.startMeeting")}
            </PanelButton>
          )}
        </div>
      </div>
    </div>
  );
};

export default MeetingPanel;
