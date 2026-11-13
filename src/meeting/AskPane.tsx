import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import {
  AlignLeft,
  ArrowUp,
  Check,
  Copy,
  Gauge,
  ListChecks,
  Lock,
  Mail,
  MessageCircleQuestionMark,
  NotebookPen,
  Quote,
  RotateCcw,
  Rewind,
  Scale,
  Sparkles,
  Square,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { commands } from "@/bindings";
import type {
  MeetingChatAvailability,
  MeetingChatExchange,
  MeetingChatMessage,
  MeetingChatPreset,
} from "@/bindings";
import { RichText, stripCitations } from "./RichText";

/**
 * The Ask tab: a conversation with the meeting.
 *
 * Design notes:
 * - It lives under the live transcript, in the pane the notepad uses, rather
 *   than replacing it. The whole point is asking about what is being said
 *   *while* it is being said; a chat that hid the transcript would make the
 *   user choose between the meeting and the question about it.
 * - One tap is the common case. Most of what people want mid-call is the same
 *   handful of things — catch me up, who owes what, what should I ask, how is
 *   this going — so those are presets with carefully written briefs behind
 *   them (see `meetings::chat::preset_instruction`). The thread shows the
 *   preset's label as the user's turn, not the brief, so it reads like a
 *   conversation.
 * - Answers stream, and cite the transcript as `[12:04]` chips that scroll the
 *   transcript above to that moment. Checking an answer costs one click.
 * - The thread is stored per meeting, so the panel can close and reopen, and
 *   the library can show it later. A question that failed is not stored — it
 *   stays on screen with a retry, and goes when the panel does.
 * - A question can arrive from outside this pane: the catch-up shortcut asks
 *   it from Rust. `meeting-chat-started` is what tells the pane, and
 *   `onExternalQuestion` is what brings the tab forward to show it.
 */

/** What can be asked during a meeting, in the order offered. */
const LIVE_PRESETS: MeetingChatPreset[] = [
  "catch_up",
  "action_items",
  "suggest_question",
  "talking_points",
  "sentiment",
  "summary",
];

/** After it: the record, and what to do with it. */
const AFTER_PRESETS: MeetingChatPreset[] = [
  "summary",
  "action_items",
  "follow_up_email",
  "decisions",
  "sentiment",
  "talking_points",
];

const PRESET_ICONS: Record<
  MeetingChatPreset,
  React.FC<{ className?: string }>
> = {
  catch_up: Rewind,
  summary: AlignLeft,
  action_items: ListChecks,
  suggest_question: MessageCircleQuestionMark,
  talking_points: Target,
  sentiment: Gauge,
  decisions: Scale,
  follow_up_email: Mail,
};

/** A quoted passage is capped so one long selection can't become the prompt. */
const MAX_QUOTE_CHARS = 600;

/** A question whose answer has not been stored yet. */
interface Pending {
  requestId: string;
  body: string;
  preset: MeetingChatPreset | null;
  answer: string;
  status: "streaming" | "failed";
  error?: string;
}

export interface AskPaneHandle {
  /** Brings the cursor to the question box. */
  focus: () => void;
  /** Starts a question about a passage the user selected in the transcript. */
  askAbout: (quote: string) => void;
}

interface AskPaneProps {
  meetingId: string | null;
  /** Capture is running (or draining) — presets are worded for a live call. */
  live: boolean;
  hasTranscript: boolean;
  /** The tab is showing. Hidden panes stay mounted so a stream keeps going. */
  visible: boolean;
  /** Where the pane's header controls render — owned by the panel's tab bar. */
  headerSlot: HTMLElement | null;
  onCite: (ms: number) => void;
  onAddToNotes: (text: string) => void;
  /** A question was asked from outside the pane, e.g. the catch-up shortcut. */
  onExternalQuestion: () => void;
}

/** A user turn: a preset label, a quote and a question, or plain words. */
const UserTurn: React.FC<{
  body: string;
  preset: MeetingChatPreset | null;
}> = ({ body, preset }) => {
  const { t } = useTranslation();
  if (preset) {
    const Icon = PRESET_ICONS[preset];
    return (
      <div className="ml-auto inline-flex max-w-[85%] items-center gap-1.5 rounded-[14px] rounded-br-[5px] bg-accent/[0.14] px-3 py-1.5 text-[12.5px] font-medium text-text">
        <Icon className="h-3.5 w-3.5 shrink-0 text-accent-bright" />
        {t(`meeting.ask.presets.${preset}.label`)}
      </div>
    );
  }
  let quote: string | null = null;
  let question = body;
  if (body.startsWith("> ")) {
    const split = body.indexOf("\n\n");
    quote = (split === -1 ? body : body.slice(0, split)).replace(/^> ?/gm, "");
    question = split === -1 ? "" : body.slice(split + 2);
  }
  return (
    <div className="ml-auto max-w-[85%] rounded-[14px] rounded-br-[5px] bg-accent/[0.14] px-3 py-2 text-[13px] leading-[1.5] text-text">
      {quote && (
        <p className="mb-1.5 line-clamp-3 border-l-2 border-accent/50 pl-2 text-[12px] italic text-text-muted">
          {quote}
        </p>
      )}
      <p className="whitespace-pre-wrap break-words">{question}</p>
    </div>
  );
};

/** Copy and add-to-notes, under an answer. */
const AnswerActions: React.FC<{
  text: string;
  onAddToNotes: (text: string) => void;
  always: boolean;
}> = ({ text, onAddToNotes, always }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!copied && !added) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setAdded(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [copied, added]);

  const button =
    "inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] font-medium text-text-subtle transition-colors duration-150 hover:bg-fill-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

  return (
    <div
      className={`mt-1 flex items-center gap-0.5 transition-opacity duration-150 ${
        always || copied || added
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      }`}
    >
      <button
        type="button"
        className={button}
        onClick={() => {
          // Citations point into a transcript that isn't where this is going.
          void navigator.clipboard
            .writeText(stripCitations(text))
            .then(() => setCopied(true));
        }}
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {copied ? t("meeting.ask.copied") : t("meeting.ask.copy")}
      </button>
      <button
        type="button"
        className={button}
        onClick={() => {
          onAddToNotes(text);
          setAdded(true);
        }}
      >
        {added ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <NotebookPen className="h-3 w-3" />
        )}
        {added ? t("meeting.ask.addedToNotes") : t("meeting.ask.addToNotes")}
      </button>
    </div>
  );
};

const GhostlyAvatar: React.FC<{ busy?: boolean }> = ({ busy }) => (
  <span
    className={`mt-[1px] flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent/30 to-accent-alt/20 text-accent-bright ring-1 ring-accent/25 ${
      busy ? "animate-pulse-ring" : ""
    }`}
    aria-hidden
  >
    <Sparkles className="h-[11px] w-[11px]" />
  </span>
);

export const AskPane = forwardRef<AskPaneHandle, AskPaneProps>(
  (
    {
      meetingId,
      live,
      hasTranscript,
      visible,
      headerSlot,
      onCite,
      onAddToNotes,
      onExternalQuestion,
    },
    ref,
  ) => {
    const { t } = useTranslation();

    const [messages, setMessages] = useState<MeetingChatMessage[]>([]);
    const [pending, setPending] = useState<Pending[]>([]);
    // Answers the user stopped, by message id, so the thread can say so.
    const [stopped, setStopped] = useState<Set<number>>(() => new Set());
    const [draft, setDraft] = useState("");
    const [quote, setQuote] = useState<string | null>(null);
    const [availability, setAvailability] =
      useState<MeetingChatAvailability | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const threadRef = useRef<HTMLDivElement>(null);
    const stickToBottom = useRef(true);
    // Read by event handlers registered once on mount.
    const meetingIdRef = useRef<string | null>(meetingId);
    const pendingRef = useRef<Pending[]>([]);
    pendingRef.current = pending;
    // Each request settles exactly once, whichever of the command's return and
    // the `meeting-chat-finished` event arrives first.
    const settled = useRef<Set<string>>(new Set());
    // Requests this pane started, recorded synchronously — `pending` state may
    // not have re-rendered by the time the backend's `meeting-chat-started`
    // for the same request arrives, and that event must not add it twice.
    const localRequests = useRef<Set<string>>(new Set());
    const onExternalRef = useRef(onExternalQuestion);
    onExternalRef.current = onExternalQuestion;

    const busy = pending.some((p) => p.status === "streaming");
    const presets = live ? LIVE_PRESETS : AFTER_PRESETS;
    const ready = availability === "cloud" || availability === "on_device";
    const canAsk = ready && meetingId !== null && hasTranscript && !busy;

    // ---- Loading -----------------------------------------------------------

    useEffect(() => {
      meetingIdRef.current = meetingId;
      setPending([]);
      setStopped(new Set());
      setQuote(null);
      setConfirmClear(false);
      settled.current = new Set();
      stickToBottom.current = true;
      if (!meetingId) {
        setMessages([]);
        return;
      }
      let active = true;
      void commands.getMeetingChat(meetingId).then((result) => {
        if (!active || meetingIdRef.current !== meetingId) return;
        setMessages(result.status === "ok" ? result.data : []);
      });
      return () => {
        active = false;
      };
    }, [meetingId]);

    // Asked whenever the tab comes into view: the user may have just been to
    // Settings to choose a model.
    const refreshAvailability = useCallback(() => {
      void commands.getMeetingChatAvailability().then(setAvailability);
    }, []);
    useEffect(() => {
      if (visible) refreshAvailability();
    }, [visible, refreshAvailability]);
    useEffect(() => {
      window.addEventListener("focus", refreshAvailability);
      return () => window.removeEventListener("focus", refreshAvailability);
    }, [refreshAvailability]);

    // ---- Settling ----------------------------------------------------------

    const settle = useCallback(
      (
        requestId: string,
        exchange: MeetingChatExchange | null,
        error: string | null,
      ) => {
        if (settled.current.has(requestId)) return;
        settled.current.add(requestId);

        if (exchange) {
          setPending((previous) =>
            previous.filter((p) => p.requestId !== requestId),
          );
          if (exchange.question.meetingId !== meetingIdRef.current) return;
          setMessages((previous) => {
            const ids = new Set(previous.map((m) => m.id));
            return [
              ...previous,
              ...[exchange.question, exchange.answer].filter(
                (m) => !ids.has(m.id),
              ),
            ];
          });
          if (exchange.stopped) {
            setStopped((previous) => new Set(previous).add(exchange.answer.id));
          }
          return;
        }

        // Stopped before a word arrived: nothing was stored, nothing to show.
        if (error === "cancelled") {
          setPending((previous) =>
            previous.filter((p) => p.requestId !== requestId),
          );
          return;
        }
        setPending((previous) =>
          previous.map((p) =>
            p.requestId === requestId
              ? { ...p, status: "failed", error: error ?? undefined }
              : p,
          ),
        );
      },
      [],
    );

    useEffect(() => {
      let active = true;

      const unlistenStarted = listen<{
        meetingId: string;
        requestId: string;
        question: MeetingChatMessage;
      }>("meeting-chat-started", (event) => {
        if (!active) return;
        const { meetingId: id, requestId, question } = event.payload;
        if (id !== meetingIdRef.current) return;
        if (localRequests.current.has(requestId)) return;
        if (pendingRef.current.some((p) => p.requestId === requestId)) return;
        // Asked from elsewhere — the shortcut. Show it arriving.
        stickToBottom.current = true;
        setPending((previous) => [
          ...previous,
          {
            requestId,
            body: question.body,
            preset: question.preset,
            answer: "",
            status: "streaming",
          },
        ]);
        onExternalRef.current();
      });

      const unlistenDelta = listen<{
        meetingId: string;
        requestId: string;
        delta: string;
      }>("meeting-chat-delta", (event) => {
        if (!active) return;
        const { requestId, delta } = event.payload;
        setPending((previous) =>
          previous.map((p) =>
            p.requestId === requestId ? { ...p, answer: p.answer + delta } : p,
          ),
        );
      });

      const unlistenFinished = listen<{
        meetingId: string;
        requestId: string;
        exchange: MeetingChatExchange | null;
        error: string | null;
      }>("meeting-chat-finished", (event) => {
        if (!active) return;
        const { requestId, exchange, error } = event.payload;
        settle(requestId, exchange, error);
      });

      return () => {
        active = false;
        void unlistenStarted.then((fn) => fn());
        void unlistenDelta.then((fn) => fn());
        void unlistenFinished.then((fn) => fn());
      };
    }, [settle]);

    // ---- Asking ------------------------------------------------------------

    const ask = useCallback(
      async (body: string, preset: MeetingChatPreset | null) => {
        const id = meetingIdRef.current;
        if (!id) return;
        const requestId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        localRequests.current.add(requestId);
        stickToBottom.current = true;
        setPending((previous) => [
          ...previous,
          { requestId, body, preset, answer: "", status: "streaming" },
        ]);
        const result = await commands.askMeeting(id, requestId, body, preset);
        settle(
          requestId,
          result.status === "ok" ? result.data : null,
          result.status === "error" ? result.error : null,
        );
      },
      [settle],
    );

    const send = () => {
      if (!canAsk) return;
      const text = draft.trim();
      if (!text && !quote) return;
      const body = quote
        ? `> ${quote.replace(/\s+/g, " ")}\n\n${text || t("meeting.ask.explainQuote")}`
        : text;
      setDraft("");
      setQuote(null);
      void ask(body, null);
    };

    const stop = () => {
      for (const p of pendingRef.current) {
        if (p.status === "streaming")
          void commands.cancelMeetingChat(p.requestId);
      }
    };

    const retry = (failed: Pending) => {
      setPending((previous) =>
        previous.filter((p) => p.requestId !== failed.requestId),
      );
      void ask(failed.body, failed.preset);
    };

    const clearThread = async () => {
      if (!meetingId) return;
      if (!confirmClear) {
        setConfirmClear(true);
        return;
      }
      setConfirmClear(false);
      const result = await commands.clearMeetingChat(meetingId);
      if (result.status === "ok") {
        setMessages([]);
        setStopped(new Set());
      }
    };

    // An armed "clear" disarms itself; a destructive button that stays primed
    // is one stray click from deleting the conversation.
    useEffect(() => {
      if (!confirmClear) return;
      const timer = window.setTimeout(() => setConfirmClear(false), 3000);
      return () => window.clearTimeout(timer);
    }, [confirmClear]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          requestAnimationFrame(() => inputRef.current?.focus());
        },
        askAbout: (text: string) => {
          const trimmed = text.replace(/\s+/g, " ").trim();
          if (!trimmed) return;
          setQuote(
            trimmed.length > MAX_QUOTE_CHARS
              ? `${trimmed.slice(0, MAX_QUOTE_CHARS).trimEnd()}…`
              : trimmed,
          );
          requestAnimationFrame(() => inputRef.current?.focus());
        },
      }),
      [],
    );

    // ---- Scrolling ---------------------------------------------------------

    // Follows the answer as it streams, unless the user has scrolled up to
    // read something — same rule as the transcript.
    //
    // An empty thread is the exception: it is the suggestions, read top-down,
    // and pinning them to the bottom hid their own heading.
    useEffect(() => {
      const node = threadRef.current;
      if (!node) return;
      if (messages.length === 0 && pending.length === 0) {
        node.scrollTop = 0;
        return;
      }
      if (stickToBottom.current) node.scrollTop = node.scrollHeight;
    }, [messages, pending, visible]);

    // The box grows with what is typed, to a point.
    useEffect(() => {
      const node = inputRef.current;
      if (!node) return;
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
    }, [draft, visible]);

    // ---- Rendering ---------------------------------------------------------

    const empty = messages.length === 0 && pending.length === 0;
    const lastAnswerId = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.id;

    const headerControls =
      visible && headerSlot && messages.length > 0
        ? createPortal(
            <button
              type="button"
              onClick={() => void clearThread()}
              disabled={busy}
              title={t("meeting.ask.newChat")}
              aria-label={t("meeting.ask.newChat")}
              className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                confirmClear
                  ? "bg-danger/12 text-danger"
                  : "text-text-subtle hover:bg-fill-2 hover:text-text"
              }`}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
              {confirmClear && t("meeting.ask.clearConfirm")}
            </button>,
            headerSlot,
          )
        : null;

    const presetButton = (preset: MeetingChatPreset, compact: boolean) => {
      const Icon = PRESET_ICONS[preset];
      const label = t(`meeting.ask.presets.${preset}.label`);
      if (compact) {
        return (
          <button
            key={preset}
            type="button"
            disabled={!canAsk}
            onClick={() => void ask(label, preset)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill-2 px-2.5 py-[5px] text-[11px] font-medium text-text-muted ring-1 ring-hairline transition-[background-color,color,transform] duration-150 hover:bg-fill-3 hover:text-text active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Icon className="h-3 w-3 text-accent" />
            {label}
          </button>
        );
      }
      return (
        <button
          key={preset}
          type="button"
          disabled={!canAsk}
          onClick={() => void ask(label, preset)}
          className="group/preset flex min-w-0 items-center gap-2 rounded-[11px] bg-fill-1 px-2 py-[7px] text-left ring-1 ring-hairline transition-[background-color,box-shadow,transform] duration-150 hover:bg-fill-2 hover:ring-accent/30 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px] bg-accent/12 text-accent-bright transition-colors duration-150 group-hover/preset:bg-accent/20">
            <Icon className="h-3 w-3" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium leading-tight text-text">
              {label}
            </span>
            <span className="mt-[1px] block truncate text-[10.5px] leading-tight text-text-subtle">
              {t(`meeting.ask.presets.${preset}.hint`)}
            </span>
          </span>
        </button>
      );
    };

    let emptyState: React.ReactNode = null;
    if (empty) {
      if (availability !== null && !ready) {
        emptyState = (
          <div className="flex flex-col items-center gap-2 px-6 py-6 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-fill-2 text-text-subtle">
              <Lock className="h-4 w-4" />
            </span>
            <p className="text-[12.5px] font-medium text-text">
              {t("meeting.ask.unavailableTitle")}
            </p>
            <p className="max-w-[260px] text-[11.5px] leading-[1.5] text-text-subtle">
              {t(`meeting.ask.unavailable.${availability}`)}
            </p>
            <button
              type="button"
              onClick={() => void commands.showMainWindowCommand()}
              className="mt-1 rounded-lg bg-fill-2 px-2.5 py-1 text-[11px] font-medium text-text-muted transition-colors duration-150 hover:bg-fill-3 hover:text-text"
            >
              {t("meeting.ask.openSettings")}
            </button>
          </div>
        );
      } else if (!meetingId || !hasTranscript) {
        emptyState = (
          <div className="flex flex-col items-center gap-2 px-6 py-6 text-center">
            <GhostlyAvatar />
            <p className="text-[12.5px] font-medium text-text">
              {t("meeting.ask.noMeetingTitle")}
            </p>
            <p className="max-w-[260px] text-[11.5px] leading-[1.5] text-text-subtle">
              {meetingId
                ? t("meeting.ask.waitingBody")
                : t("meeting.ask.noMeetingBody")}
            </p>
          </div>
        );
      } else {
        emptyState = (
          <div className="animate-rise px-1 pb-1 pt-2">
            <div className="mb-3 flex items-center gap-2 px-1">
              <GhostlyAvatar />
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-text">
                  {t("meeting.ask.emptyTitle")}
                </p>
                <p className="text-[11px] leading-[1.45] text-text-subtle">
                  {live
                    ? t("meeting.ask.emptyBody")
                    : t("meeting.ask.emptyBodyFinished")}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
              {presets.map((preset) => presetButton(preset, false))}
            </div>
          </div>
        );
      }
    }

    return (
      <div
        className={`min-h-0 flex-1 flex-col ${visible ? "flex" : "hidden"}`}
        aria-label={t("meeting.workspace.ask")}
      >
        {headerControls}

        <div
          ref={threadRef}
          onScroll={() => {
            const node = threadRef.current;
            if (!node) return;
            stickToBottom.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 40;
          }}
          role="log"
          aria-live="polite"
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-1"
        >
          {emptyState}

          <div className="space-y-3">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex animate-rise">
                  <UserTurn body={message.body} preset={message.preset} />
                </div>
              ) : (
                <div key={message.id} className="group flex gap-2">
                  <GhostlyAvatar />
                  <div className="min-w-0 flex-1">
                    <RichText text={message.body} onCite={onCite} />
                    {stopped.has(message.id) && (
                      <p className="mt-1 text-[10.5px] text-text-faint">
                        {t("meeting.ask.stopped")}
                      </p>
                    )}
                    <AnswerActions
                      text={message.body}
                      onAddToNotes={onAddToNotes}
                      always={message.id === lastAnswerId && !busy}
                    />
                  </div>
                </div>
              ),
            )}

            {pending.map((item) => (
              <React.Fragment key={item.requestId}>
                <div className="flex animate-rise">
                  <UserTurn body={item.body} preset={item.preset} />
                </div>
                <div className="flex gap-2">
                  <GhostlyAvatar busy={item.status === "streaming"} />
                  <div className="min-w-0 flex-1">
                    {item.status === "failed" ? (
                      <div className="rounded-lg bg-danger/10 px-2.5 py-2">
                        <p className="text-[12px] leading-[1.45] text-danger">
                          {item.error}
                        </p>
                        <button
                          type="button"
                          onClick={() => retry(item)}
                          className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] font-medium text-text-muted transition-colors duration-150 hover:bg-fill-2 hover:text-text"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {t("meeting.ask.retry")}
                        </button>
                      </div>
                    ) : item.answer ? (
                      <RichText text={item.answer} onCite={onCite} streaming />
                    ) : (
                      <p className="flex items-center gap-2 pt-[2px] text-[12px]">
                        <span className="shimmer-text">
                          {t("meeting.ask.thinking")}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>

        {/* The composer. Presets ride above it once a conversation exists —
            the empty state already shows them as cards. */}
        <div className="shrink-0 px-2.5 pb-2.5 pt-1">
          {!empty && ready && hasTranscript && (
            // Scrolls sideways; the fade at the edge is what says so.
            <div className="-mx-2.5 mb-1.5 flex gap-1.5 overflow-x-auto px-2.5 pb-0.5 [mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {presets.map((preset) => presetButton(preset, true))}
            </div>
          )}

          <div
            className={`rounded-[13px] bg-surface-1 ring-1 transition-[box-shadow] duration-150 ${
              canAsk || busy
                ? "ring-hairline-strong focus-within:ring-accent/45 focus-within:shadow-[0_0_0_4px_var(--color-accent-glow)]"
                : "ring-hairline opacity-70"
            }`}
          >
            {quote && (
              <div className="flex items-start gap-1.5 border-b border-hairline px-2.5 pb-1.5 pt-2">
                <Quote className="mt-[2px] h-3 w-3 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium uppercase tracking-[0.07em] text-text-subtle">
                    {t("meeting.ask.quoting")}
                  </p>
                  <p className="line-clamp-2 text-[11.5px] italic text-text-muted">
                    {quote}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setQuote(null)}
                  aria-label={t("meeting.ask.removeQuote")}
                  className="shrink-0 rounded p-0.5 text-text-faint transition-colors duration-150 hover:bg-fill-2 hover:text-text"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="flex items-end gap-1.5 p-1.5 pl-2.5">
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                disabled={!ready || !meetingId}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  } else if (event.key === "Escape") {
                    if (busy) stop();
                    else if (quote) setQuote(null);
                  }
                }}
                placeholder={
                  meetingId
                    ? quote
                      ? t("meeting.ask.placeholderQuote")
                      : t("meeting.ask.placeholder")
                    : t("meeting.ask.placeholderNoMeeting")
                }
                spellCheck
                className="max-h-[120px] min-h-[24px] flex-1 resize-none bg-transparent py-[3px] text-[13px] leading-[1.45] text-text outline-none placeholder:text-text-faint disabled:cursor-not-allowed"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  title={t("meeting.ask.stop")}
                  aria-label={t("meeting.ask.stop")}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-text text-canvas transition-transform duration-150 active:scale-90"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!canAsk || (!draft.trim() && !quote)}
                  title={t("meeting.ask.send")}
                  aria-label={t("meeting.ask.send")}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-accent text-canvas transition-[background-color,opacity,transform] duration-150 hover:bg-accent-bright active:scale-90 disabled:bg-fill-3 disabled:text-text-faint"
                >
                  <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>

          {availability === "on_device" && (
            <p className="mt-1.5 px-1 text-[10px] text-text-faint">
              {t("meeting.ask.onDeviceNote")}
            </p>
          )}
        </div>
      </div>
    );
  },
);

AskPane.displayName = "AskPane";

export default AskPane;
