import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
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
 *   wrap-up summary; wiping it on stop would destroy exactly that workflow.
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

interface DetectedPayload {
  bundleId: string;
  displayName: string;
  countdownSecs: number | null;
}

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

  // Keyed by *segment*, not speaker: keying by speaker renders an autoFocus
  // input on every line that speaker owns, and the browser hands focus to the
  // last one while every keystroke is mirrored across all of them.
  const [editingSegmentId, setEditingSegmentId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const speakerById = useMemo(() => {
    const map = new Map<string, MeetingSpeaker>();
    for (const speaker of speakers) map.set(speaker.id, speaker);
    return map;
  }, [speakers]);

  const refreshTranscript = useCallback(async (meetingId: string) => {
    const [segmentsResult, speakersResult] = await Promise.all([
      commands.getMeetingSegments(meetingId),
      commands.getMeetingSpeakers(meetingId),
    ]);
    if (segmentsResult.status === "ok") setSegments(segmentsResult.data);
    if (speakersResult.status === "ok") setSpeakers(speakersResult.data);
  }, []);

  useEffect(() => {
    let active = true;

    void commands.getMeetingStatus().then((current) => {
      if (!active) return;
      setStatus(current);
      if (current.meetingId) void refreshTranscript(current.meetingId);
    });

    const unlistenStatus = listen<{ status: MeetingStatus }>(
      "meeting-status",
      (event) => {
        if (!active) return;
        const next = event.payload.status;
        setStatus(next);
        // A new meeting replaces the transcript; the *end* of one keeps it.
        if (next.meetingId) void refreshTranscript(next.meetingId);
      },
    );

    const unlistenSegment = listen<{
      segment: MeetingSegment;
      speaker: MeetingSpeaker | null;
    }>("meeting-segment", (event) => {
      if (!active) return;
      const incoming = event.payload.segment;
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

    // Someone said your name. The highest-value alert in a meeting, and the one
    // most likely to be missed, so it gets a banner rather than another line.
    const unlistenMention = listen<{ text: string }>(
      "meeting-mention",
      (event) => {
        if (active) setMention(event.payload.text);
      },
    );

    const unlistenCatchUp = listen<string>("meeting-catch-up", (event) => {
      if (!active) return;
      setSummaryHeading("catchUpHeading");
      setSummary(event.payload);
    });

    // Ending a meeting kicks off a wrap-up automatically.
    const unlistenSummarizing = listen("meeting-summarizing", () => {
      if (active) setSummarizing(true);
    });
    const unlistenFinal = listen<string>("meeting-final-summary", (event) => {
      if (!active) return;
      setSummarizing(false);
      setSummaryHeading("finalSummaryHeading");
      setSummary(event.payload);
    });
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
      void unlistenStatus.then((fn) => fn());
      void unlistenSegment.then((fn) => fn());
      void unlistenMention.then((fn) => fn());
      void unlistenCatchUp.then((fn) => fn());
      void unlistenSummarizing.then((fn) => fn());
      void unlistenFinal.then((fn) => fn());
      void unlistenFinalFailed.then((fn) => fn());
      void unlistenDetected.then((fn) => fn());
      void unlistenCleared.then((fn) => fn());
    };
  }, [refreshTranscript]);

  // Capture starting resolves the prompt either way.
  useEffect(() => {
    if (status?.active) setDetected(null);
  }, [status?.active]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [segments]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distanceFromBottom < 48;
  };

  const handleCatchUp = async () => {
    setSummarizing(true);
    setError(null);
    const result = await commands.catchMeUp(status?.meetingId ?? null);
    setSummarizing(false);
    if (result.status === "ok") setSummary(result.data);
    else setError(result.error);
  };

  const handleEndMeeting = async () => {
    const result = await commands.stopMeeting();
    if (result.status === "error") setError(result.error);
    // The panel stays open on purpose: the wrap-up summary lands here, and the
    // user still wants to read back and name speakers.
  };

  const handleTogglePause = async () => {
    const result = await commands.setMeetingPaused(!(status?.paused ?? false));
    if (result.status === "error") setError(result.error);
  };

  // NSPanel: `getCurrentWindow().hide()` from the webview does not reliably
  // hide a panel, so closing goes through the same main-thread path that
  // created it.
  const handleClose = () => {
    void commands.hideMeetingPanel();
  };

  const commitSpeakerName = async (speakerId: string) => {
    const name = draftName.trim();
    setEditingSegmentId(null);
    if (!name) return;
    const result = await commands.renameMeetingSpeaker(speakerId, name);
    if (result.status === "ok") {
      setSpeakers((previous) =>
        previous.map((s) =>
          s.id === speakerId ? { ...s, displayName: name, kind: "named" } : s,
        ),
      );
    } else {
      setError(result.error);
    }
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

  const active = status?.active ?? false;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-hairline bg-surface-1/95 text-text backdrop-blur-xl">
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 border-b border-hairline px-3 py-2"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            active && !status?.paused
              ? "animate-pulse bg-danger"
              : active
                ? "bg-warning"
                : "bg-text-faint"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">
            {status?.title ?? t("meeting.panel.title")}
          </div>
          {active && status?.paused && (
            <div className="truncate text-[11px] text-warning">
              {t("meeting.panel.pausedNotice")}
            </div>
          )}
          {active && !status?.paused && !status?.systemAudioActive && (
            <div className="truncate text-[11px] text-warning">
              {t("meeting.panel.micOnly")}
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
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2"
      >
        {segments.length === 0 ? (
          <p className="mt-6 text-center text-[12px] text-text-subtle">
            {active
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
        {active ? (
          <>
            <button
              type="button"
              onClick={() => void handleTogglePause()}
              className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
            >
              {status?.paused
                ? t("meeting.panel.resume")
                : t("meeting.panel.pause")}
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
            onClick={handleClose}
            className="rounded-md border border-hairline-strong px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
          >
            {t("meeting.panel.close")}
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
