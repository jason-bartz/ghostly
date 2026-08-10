import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Pencil } from "lucide-react";
import { usePanelTheme } from "./usePanelTheme";
import { commands } from "@/bindings";
import type { MeetingSegment, MeetingSpeaker, MeetingStatus } from "@/bindings";

/**
 * The floating live transcript.
 *
 * Design notes:
 * - Auto-scroll sticks to the bottom but releases the moment the user scrolls
 *   up. Yanking someone back to the live edge while they are reading is the
 *   single most annoying thing a live transcript can do.
 * - The transcript is deliberately NOT cleared when capture stops. The panel
 *   stays open afterwards so the user can read it, name speakers and run a
 *   wrap-up summary; wiping it on stop would destroy exactly that workflow. It
 *   *is* cleared when the next meeting starts — see `meeting-starting`.
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

/** An action applied locally while its command is still in flight. */
type Pending = { paused?: boolean; ending?: boolean; starting?: boolean };

const MeetingPanel: React.FC = () => {
  const { t } = useTranslation();
  usePanelTheme();

  const [status, setStatus] = useState<MeetingStatus | null>(null);
  const [segments, setSegments] = useState<MeetingSegment[]>([]);
  const [speakers, setSpeakers] = useState<MeetingSpeaker[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedPayload | null>(null);
  const [summaryHeading, setSummaryHeading] = useState("catchUpHeading");
  const [pending, setPending] = useState<Pending>({});

  // Keyed by *segment*, not speaker: keying by speaker renders an autoFocus
  // input on every line that speaker owns, and the browser hands focus to the
  // last one while every keystroke is mirrored across all of them.
  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");

  // Held separately from `status.title`, which reverts to the default snapshot
  // the moment capture stops — the panel would otherwise forget the meeting's
  // name while still showing its transcript.
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  // `null` means "not editing"; the empty string is a legitimate draft.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // The meeting the panel is showing. Not `status.meetingId`: that goes null
  // the moment capture stops, while the panel deliberately keeps the finished
  // transcript on screen — and renaming it or catching up on it both still need
  // an id. Cleared only when the next meeting begins.
  const [meetingId, setMeetingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Mirrors `meetingId` for the event handlers, which capture their closure
  // once on mount and would otherwise read a stale value.
  const meetingIdRef = useRef<string | null>(null);

  const adoptMeeting = useCallback((id: string | null) => {
    meetingIdRef.current = id;
    setMeetingId(id);
  }, []);

  const speakerById = useMemo(() => {
    const map = new Map<string, MeetingSpeaker>();
    for (const speaker of speakers) map.set(speaker.id, speaker);
    return map;
  }, [speakers]);

  const clearTranscript = useCallback(() => {
    setSegments([]);
    setSpeakers([]);
    setSummary(null);
    setSummarizing(false);
    setMention(null);
    setError(null);
    setEditingSegmentId(null);
    setTitleDraft(null);
    setMeetingTitle(null);
    setElapsed(0);
    stickToBottom.current = true;
  }, []);

  const refreshTranscript = useCallback(async (meetingId: string) => {
    const [segmentsResult, speakersResult] = await Promise.all([
      commands.getMeetingSegments(meetingId),
      commands.getMeetingSpeakers(meetingId),
    ]);
    // A meeting that ended while the queries were in flight must not have the
    // next one's transcript written over it.
    if (meetingIdRef.current !== meetingId) return;
    if (segmentsResult.status === "ok") setSegments(segmentsResult.data);
    if (speakersResult.status === "ok") setSpeakers(speakersResult.data);
  }, []);

  useEffect(() => {
    let active = true;

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

    const unlistenSegment = listen<{
      segment: MeetingSegment;
      speaker: MeetingSpeaker | null;
    }>("meeting-segment", (event) => {
      if (!active) return;
      const incoming = event.payload.segment;
      // A segment can beat the status event that announces its meeting; when it
      // does, it is the authority on which meeting the panel is showing.
      if (meetingIdRef.current === null) adoptMeeting(incoming.meetingId);
      else if (incoming.meetingId !== meetingIdRef.current) return;
      setSegments((previous) =>
        // A refresh racing an event can deliver the same row twice, which would
        // duplicate the line and the React key.
        previous.some((s) => s.id === incoming.id)
          ? previous
          : [...previous, incoming],
      );
      const speaker = event.payload.speaker;
      if (speaker) {
        setSpeakers((previous) =>
          previous.some((s) => s.id === speaker.id)
            ? previous
            : [...previous, speaker],
        );
      }
    });

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

    return () => {
      active = false;
      void unlistenStarting.then((fn) => fn());
      void unlistenStartFailed.then((fn) => fn());
      void unlistenStatus.then((fn) => fn());
      void unlistenSegment.then((fn) => fn());
      void unlistenRefined.then((fn) => fn());
      void unlistenMention.then((fn) => fn());
      void unlistenCatchUp.then((fn) => fn());
      void unlistenSummarizing.then((fn) => fn());
      void unlistenFinal.then((fn) => fn());
      void unlistenFinalFailed.then((fn) => fn());
      void unlistenDetected.then((fn) => fn());
      void unlistenCleared.then((fn) => fn());
    };
  }, [adoptMeeting, clearTranscript, refreshTranscript]);

  // Capture starting resolves the prompt either way.
  useEffect(() => {
    if (status?.active) setDetected(null);
  }, [status?.active]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [segments]);

  const active = (status?.active ?? false) && !pending.ending;
  const paused = pending.paused ?? status?.paused ?? false;
  // Capture is over but queued audio is still being transcribed. Lines keep
  // arriving, so the panel says so rather than looking like it has stalled.
  const draining = status?.draining ?? false;
  const startedAt = status?.startedAt ?? null;

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
    // user still wants to read back and name speakers.
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

  // NSPanel: `getCurrentWindow().hide()` from the webview does not reliably
  // hide a panel, so closing goes through the same main-thread path that
  // created it. Nothing to apply optimistically — the window itself is the
  // feedback — but it must not wait on anything either.
  const handleClose = () => {
    void commands.hideMeetingPanel();
  };

  const commitSpeakerName = async (speakerId: string) => {
    const name = draftName.trim();
    setEditingSegmentId(null);
    if (!name) return;
    // Applied first: renaming touches SQLite, and a label that lags a keystroke
    // behind reads as a dropped edit.
    setSpeakers((previous) =>
      previous.map((s) =>
        s.id === speakerId ? { ...s, displayName: name, kind: "named" } : s,
      ),
    );
    const result = await commands.renameMeetingSpeaker(speakerId, name);
    if (result.status === "error") setError(result.error);
  };

  const commitTitle = async () => {
    const next = (titleDraft ?? "").trim();
    setTitleDraft(null);
    if (!meetingId || next === (meetingTitle ?? "")) return;
    setMeetingTitle(next || null);
    const result = await commands.setMeetingTitle(meetingId, next);
    if (result.status === "error") setError(result.error);
  };

  const displayNameFor = (segment: MeetingSegment): string => {
    const speaker = segment.speakerId
      ? speakerById.get(segment.speakerId)
      : undefined;
    if (speaker?.displayName) return speaker.displayName;
    return segment.lane === "mic"
      ? t("meeting.panel.you")
      : t("meeting.panel.participant");
  };

  const title = meetingTitle ?? t("meeting.panel.title");
  const showDuration = startedAt !== null || elapsed > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1/95 text-text backdrop-blur-xl">
      {/* The header is the drag handle — the panel is undecorated, so this is
          the only way to move it.

          The title used to be a full-width button, which meant the one strip
          you would instinctively grab was the one strip that could not be
          grabbed: dragging worked only from the status dot, the clock, or the
          gaps between them. It is now plain text that drags like the rest of
          the bar, and editing has moved to the pencil beside it — which also
          answers the other half of the problem, that nothing said the name was
          editable at all. */}
      <div
        data-tauri-drag-region
        className="flex cursor-grab items-center gap-2 border-b border-hairline px-3 py-2 active:cursor-grabbing"
      >
        <span
          data-tauri-drag-region
          className={`h-2 w-2 shrink-0 rounded-full ${
            active && !paused
              ? "animate-pulse bg-danger"
              : active
                ? "bg-warning"
                : "bg-text-faint"
          }`}
        />
        <div data-tauri-drag-region className="min-w-0 flex-1">
          <div data-tauri-drag-region className="flex items-baseline gap-1.5">
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
                className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-2 px-1 py-[1px] text-[13px] font-medium outline-none"
              />
            ) : (
              <>
                <span
                  data-tauri-drag-region
                  className="min-w-0 shrink truncate text-[13px] font-medium"
                >
                  {title}
                </span>
                {meetingId && (
                  <button
                    type="button"
                    onClick={() => setTitleDraft(meetingTitle ?? "")}
                    title={t("meeting.panel.renameMeetingHint")}
                    aria-label={t("meeting.panel.renameMeetingHint")}
                    className="shrink-0 self-center rounded p-0.5 text-text-faint transition-colors hover:bg-fill-2 hover:text-text"
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                  </button>
                )}
                {/* Claims the slack between the title and the clock, so the
                    widest part of the bar is draggable rather than dead. */}
                <span
                  data-tauri-drag-region
                  className="min-w-0 flex-1 self-stretch"
                />
              </>
            )}
            {showDuration && (
              <span
                data-tauri-drag-region
                className="shrink-0 text-[11px] tabular-nums text-text-subtle"
                title={t("meeting.panel.durationHint")}
              >
                {formatDuration(elapsed)}
              </span>
            )}
          </div>
          {active && paused && (
            <div
              data-tauri-drag-region
              className="truncate text-[11px] text-warning"
            >
              {t("meeting.panel.pausedNotice")}
            </div>
          )}
          {active && !paused && !status?.systemAudioActive && (
            <div
              data-tauri-drag-region
              className="truncate text-[11px] text-warning"
            >
              {t("meeting.panel.micOnly")}
            </div>
          )}
          {draining && (
            <div
              data-tauri-drag-region
              className="truncate text-[11px] text-text-subtle"
            >
              {t("meeting.panel.finishing")}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="rounded px-2 py-1 text-[12px] text-text-subtle hover:bg-fill-2 hover:text-text"
        >
          {t("meeting.panel.close")}
        </button>
      </div>

      {detected && !active && (
        <div className="border-b border-accent/40 bg-accent/10 px-3 py-2">
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
              <button
                type="button"
                onClick={() => {
                  setDetected(null);
                  void commands.acceptDetectedMeeting();
                }}
                className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-canvas"
              >
                {t("meeting.detected.start")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDetected(null);
                commands.dismissDetectedMeeting();
              }}
              className="rounded-md border border-hairline-strong px-2.5 py-1 text-[11px] text-text-muted hover:text-text"
            >
              {t("meeting.detected.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDetected(null);
                void commands.neverAutoConnectApp(
                  detected.bundleId,
                  detected.displayName,
                );
              }}
              className="ml-auto text-[10px] text-text-subtle hover:text-text"
            >
              {t("meeting.detected.never", { app: detected.displayName })}
            </button>
          </div>
        </div>
      )}

      {mention && (
        <div className="flex items-start gap-2 border-b border-accent/40 bg-accent/10 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-accent">
              {t("meeting.panel.mentionHeading")}
            </p>
            <p className="break-words text-[12px] text-text">{mention}</p>
          </div>
          <button
            type="button"
            onClick={() => setMention(null)}
            className="shrink-0 text-[11px] text-text-subtle hover:text-text"
          >
            {t("meeting.panel.dismiss")}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (!node) return;
          const distanceFromBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight;
          stickToBottom.current = distanceFromBottom < 48;
        }}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        {segments.length === 0 ? (
          <p className="mt-6 text-center text-[12px] text-text-subtle">
            {pending.starting
              ? t("meeting.panel.starting")
              : active
                ? t("meeting.panel.listening")
                : t("meeting.panel.notCapturing")}
          </p>
        ) : (
          segments.map((segment) => {
            const speaker = segment.speakerId
              ? speakerById.get(segment.speakerId)
              : undefined;
            const color = speakerColor(Number(speaker?.colorIndex ?? 0));
            const isEditing = editingSegmentId === segment.id && !!speaker;
            return (
              <div key={segment.id} className="mb-2 flex gap-2">
                <span className="w-10 shrink-0 pt-[2px] text-right text-[10px] tabular-nums text-text-faint">
                  {formatClock(Number(segment.startMs))}
                </span>
                <div className="min-w-0 flex-1">
                  {isEditing && speaker ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => void commitSpeakerName(speaker.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          void commitSpeakerName(speaker.id);
                        if (e.key === "Escape") setEditingSegmentId(null);
                      }}
                      placeholder={t("meeting.panel.namePlaceholder")}
                      className="mb-[2px] w-32 rounded border border-hairline-strong bg-surface-2 px-1 py-[1px] text-[11px] outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={!speaker}
                      onClick={() => {
                        if (!speaker) return;
                        setEditingSegmentId(segment.id);
                        setDraftName(speaker.displayName ?? "");
                      }}
                      title={t("meeting.panel.renameHint")}
                      className="mb-[2px] block text-[11px] font-medium hover:underline disabled:cursor-default disabled:no-underline"
                      style={{ color }}
                    >
                      {displayNameFor(segment)}
                    </button>
                  )}
                  <p className="break-words text-[13px] leading-snug text-text-muted">
                    {segment.text}
                  </p>
                </div>
              </div>
            );
          })
        )}

        {summary && (
          <div className="mt-3 rounded-lg border border-hairline-strong bg-surface-2 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-accent">
                {t(`meeting.panel.${summaryHeading}`)}
              </span>
              <button
                type="button"
                onClick={() => setSummary(null)}
                className="text-[11px] text-text-subtle hover:text-text"
              >
                {t("meeting.panel.dismiss")}
              </button>
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-snug text-text-muted">
              {summary}
            </pre>
          </div>
        )}

        {summarizing && !summary && (
          <p className="mt-2 text-center text-[11px] text-text-subtle">
            {t("meeting.panel.wrappingUp")}
          </p>
        )}

        {error && (
          <p className="mt-2 rounded bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-hairline px-3 py-2">
        <button
          type="button"
          onClick={() => void handleCatchUp()}
          disabled={summarizing || segments.length === 0}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-canvas disabled:opacity-40"
        >
          {summarizing
            ? t("meeting.panel.catchingUp")
            : t("meeting.panel.catchMeUp")}
        </button>
        {pending.ending ? (
          <button
            type="button"
            disabled
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-text-muted opacity-40"
          >
            {t("meeting.panel.ending")}
          </button>
        ) : active ? (
          <>
            <button
              type="button"
              onClick={() => void handleTogglePause()}
              className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
            >
              {paused ? t("meeting.panel.resume") : t("meeting.panel.pause")}
            </button>
            <button
              type="button"
              onClick={() => void handleEndMeeting()}
              className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-danger hover:bg-danger/10"
            >
              {t("meeting.panel.endMeeting")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void handleStartMeeting()}
            disabled={pending.starting}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-text-muted hover:text-text disabled:opacity-40"
          >
            {pending.starting
              ? t("meeting.panel.starting")
              : t("meeting.panel.startMeeting")}
          </button>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-text-faint">
          {segments.length > 0 &&
            t("meeting.panel.lineCount", { count: segments.length })}
        </span>
      </div>
    </div>
  );
};

export default MeetingPanel;
