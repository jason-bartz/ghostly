import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  Download,
  Loader2,
  Lock,
  NotebookPen,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  commands,
  type AskAnswer,
  type AskBlocker,
  type AskScope,
  type AskSource,
} from "@/bindings";
import { Button } from "../ui/Button";
import { PageHeader } from "../ui/PageHeader";
import { SegmentedControl } from "../ui/SegmentedControl";
import { MarkdownLite } from "../ui/MarkdownLite";
import { revealInSection } from "@/lib/reveal";
import { showMaxUpgrade } from "@/lib/maxUpgrade";

/**
 * Ask your transcripts — a question in, an answer drawn from everything you
 * have dictated or recorded, with citations you can open.
 *
 * Its own destination rather than a strip above the Notes list, which is where
 * it started. Two things forced the move: it reads meetings as well as notes,
 * so living inside one of them mislabelled it; and an answer is something you
 * read, copy and follow up on, which needs the whole pane rather than a row
 * that pushed the notes it was sitting on below the fold.
 *
 * The privacy line is not decoration. Retrieval runs against the local SQLite
 * indexes and only the matching passages are sent — the difference between this
 * and every hosted "chat with your notes" product, and worth one sentence.
 */
/**
 * The last answer, kept outside the component.
 *
 * Following a citation navigates to another pane, which unmounts this one — so
 * without this, checking a source costs you the answer that sent you there.
 * Deliberately not persisted to disk: it is a scratch answer, not a document,
 * and it goes when the app does.
 */
const lastSession: {
  scope: AskScope;
  question: string;
  asked: string;
  answer: AskAnswer | null;
} = { scope: "both", question: "", asked: "", answer: null };

export const AskSection: React.FC = () => {
  const { t } = useTranslation();

  const [scope, setScope] = useState<AskScope>(lastSession.scope);
  const [question, setQuestion] = useState(lastSession.question);
  const [asked, setAsked] = useState(lastSession.asked);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(lastSession.answer);
  const [error, setError] = useState<string | null>(null);
  const [blocker, setBlocker] = useState<AskBlocker | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    lastSession.scope = scope;
    lastSession.question = question;
    lastSession.asked = asked;
    lastSession.answer = answer;
  }, [scope, question, asked, answer]);

  // Resolved once per visit: the pane is keyed on the sidebar section, so
  // coming back from Settings with a provider configured remounts it.
  useEffect(() => {
    let cancelled = false;
    void commands.askAvailability().then((state) => {
      if (!cancelled) setBlocker(state);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setAsked(q);
    try {
      const res = await commands.askTranscripts(q, scope);
      if (res.status === "ok") setAnswer(res.data);
      else setError(String(res.error));
    } finally {
      setBusy(false);
    }
  }, [question, busy, scope]);

  const reset = () => {
    setAnswer(null);
    setError(null);
    setQuestion("");
    setAsked("");
    inputRef.current?.focus();
  };

  const openSource = useCallback((source: AskSource) => {
    if (source.kind === "note") {
      const noteId = Number(source.id);
      if (!Number.isFinite(noteId)) return;
      revealInSection({ section: "history", noteId });
    } else {
      revealInSection({ section: "meeting", meetingId: source.id });
    }
  }, []);

  const onCitation = useCallback(
    (index: number) => {
      const source = answer?.sources[index - 1];
      if (source) openSource(source);
    },
    [answer, openSource],
  );

  const locked = blocker !== null && blocker !== "ready";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pt-1">
      <PageHeader
        title={t("ask.title")}
        description={t("ask.subtitle")}
        actions={
          <SegmentedControl<AskScope>
            value={scope}
            onChange={setScope}
            ariaLabel={t("ask.scope.label")}
            options={[
              {
                value: "both",
                label: t("ask.scope.both"),
                Icon: Sparkles,
              },
              {
                value: "notes",
                label: t("ask.scope.notes"),
                Icon: NotebookPen,
              },
              {
                value: "meetings",
                label: t("ask.scope.meetings"),
                Icon: Users,
              },
            ]}
          />
        }
      />

      {locked ? (
        <LockedCard blocker={blocker} />
      ) : (
        <>
          <div className="rounded-lg border border-hairline-strong bg-fill-1">
            <div className="flex items-center gap-2 p-2">
              <Sparkles
                className="ml-1 h-4 w-4 shrink-0 text-accent-bright"
                aria-hidden
              />
              <input
                ref={inputRef}
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                placeholder={t("ask.placeholder")}
                disabled={busy}
                className="h-8 min-w-0 flex-1 bg-transparent text-sm focus:outline-none
                           placeholder:text-text-faint disabled:opacity-60"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => void submit()}
                disabled={busy || question.trim().length === 0}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t("ask.submit")
                )}
              </Button>
              {(question.length > 0 || answer !== null || error !== null) && (
                <button
                  type="button"
                  onClick={reset}
                  aria-label={t("ask.clear")}
                  className="p-1.5 text-text-faint hover:text-text-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <p className="px-1 text-xs leading-snug text-text-faint">
            {t("ask.privacyNote")}
          </p>

          {error !== null && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3">
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          {answer !== null && (
            <AnswerCard
              answer={answer}
              question={asked}
              scope={scope}
              onCitation={onCitation}
              onOpenSource={openSource}
              onAskAnother={reset}
            />
          )}
        </>
      )}
    </div>
  );
};

interface LockedCardProps {
  readonly blocker: AskBlocker;
}

/**
 * What you see when there is no cloud model behind Ask.
 *
 * Previously this was a red error string under the question box, which read as
 * a malfunction — the user typed a reasonable question and the app went red at
 * them. Ask is a Max feature that a personal API key also unlocks, so the pane
 * leads with the subscription and keeps the key route as the quieter second
 * line.
 *
 * Both Max routes open the in-app upgrade page rather than a browser: someone
 * here has just been told what they cannot do and nothing about what they would
 * be buying.
 */
const LockedCard: React.FC<LockedCardProps> = ({ blocker }) => {
  const { t } = useTranslation();

  const reasonKey =
    blocker === "on_device"
      ? "ask.locked.onDevice"
      : blocker === "no_provider"
        ? "ask.locked.noProvider"
        : "ask.locked.noKey";

  return (
    <div className="surface-card space-y-4 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-5 w-5 shrink-0 text-accent-bright" />
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{t("ask.locked.title")}</p>
            <MaxPill onClick={showMaxUpgrade} />
          </div>
          <p className="text-sm leading-relaxed text-text-muted">
            {t(reasonKey)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button variant="primary" size="sm" onClick={showMaxUpgrade}>
          {t("ask.locked.subscribe")}
        </Button>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("ghostly:navigate", {
                detail: { section: "postprocessing" },
              }),
            )
          }
          className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline cursor-pointer"
        >
          {t("ask.locked.useOwnKey")}
        </button>
      </div>
    </div>
  );
};

interface MaxPillProps {
  readonly onClick: () => void;
}

/** The badge that says which tier this belongs to, and sells it when clicked. */
const MaxPill: React.FC<MaxPillProps> = ({ onClick }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("ask.locked.subscribe")}
      className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10
                 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-bright
                 transition-colors hover:border-accent/50 hover:bg-accent/20 cursor-pointer"
    >
      <Sparkles className="h-3 w-3" aria-hidden />
      {t("ask.locked.pill")}
    </button>
  );
};

interface AnswerCardProps {
  readonly answer: AskAnswer;
  readonly question: string;
  readonly scope: AskScope;
  readonly onCitation: (index: number) => void;
  readonly onOpenSource: (source: AskSource) => void;
  readonly onAskAnother: () => void;
}

const AnswerCard: React.FC<AnswerCardProps> = ({
  answer,
  question,
  scope,
  onCitation,
  onOpenSource,
  onAskAnother,
}) => {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const plainText = useMemo(
    () =>
      renderPlainText(question, answer, {
        sources: t("ask.export.sourcesHeading"),
        note: t("ask.note"),
        meeting: t("ask.meeting"),
        untitled: t("ask.untitled"),
        footer: t("ask.export.footer", { scope: t(`ask.scope.${scope}`) }),
      }),
    [question, answer, scope, t],
  );

  const copy = async () => {
    await navigator.clipboard.writeText(plainText);
    toast.success(t("ask.copied"));
  };

  const exportTxt = async () => {
    const path = await saveDialog({
      defaultPath: `${fileStem(question)}.txt`,
      filters: [{ name: t("ask.export.plainText"), extensions: ["txt"] }],
    });
    if (!path) return;
    setExporting(true);
    try {
      const res = await commands.exportAskAnswer(path, plainText);
      if (res.status === "error") toast.error(String(res.error));
      else toast.success(t("ask.export.saved"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline-strong bg-fill-1 overflow-hidden">
      <div className="px-4 py-4">
        {answer.no_matches ? (
          <p className="text-sm leading-relaxed text-text-muted">
            {answer.answer}
          </p>
        ) : (
          <MarkdownLite
            source={answer.answer}
            citationCount={answer.sources.length}
            onCitation={onCitation}
            className="text-[13.5px] leading-relaxed text-text space-y-3"
          />
        )}
      </div>

      {answer.sources.length > 0 && (
        <div className="border-t border-hairline px-4 py-3 space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">
            {t("ask.sources", { count: answer.sources.length })}
          </p>
          {answer.sources.map((source, i) => (
            <button
              key={`${source.kind}-${source.id}-${i}`}
              type="button"
              onClick={() => onOpenSource(source)}
              title={t("ask.openSource")}
              className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs
                         text-text-muted transition-colors hover:bg-fill-2 hover:text-text cursor-pointer"
            >
              <span className="shrink-0 tabular-nums text-text-faint">
                {`[${i + 1}]`}
              </span>
              <span className="shrink-0 tag">
                {source.kind === "meeting" ? t("ask.meeting") : t("ask.note")}
              </span>
              <span className="min-w-0 truncate">
                <span className="text-text">
                  {source.title || t("ask.untitled")}
                </span>
                <span className="text-text-faint">
                  {` · ${new Date(source.when * 1000).toLocaleDateString()}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-hairline px-4 py-2.5">
        <button
          type="button"
          onClick={onAskAnother}
          className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text cursor-pointer"
        >
          <Search className="h-3.5 w-3.5" aria-hidden />
          {t("ask.askAnother")}
        </button>
        <span className="mx-auto" />
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text cursor-pointer"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          {t("ask.copy")}
        </button>
        <button
          type="button"
          onClick={() => void exportTxt()}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text
                     disabled:opacity-50 cursor-pointer"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("ask.export.button")}
        </button>
      </div>
    </div>
  );
};

/**
 * The answer as something you could paste into an email.
 *
 * Markdown is left as written — it is what the model produced and what every
 * other editor will re-render — but the citations are given a legend, because
 * a bare `[3]` in a file with no sources attached is noise.
 */
function renderPlainText(
  question: string,
  answer: AskAnswer,
  labels: {
    sources: string;
    note: string;
    meeting: string;
    untitled: string;
    footer: string;
  },
): string {
  const lines = [question, "", answer.answer];
  if (answer.sources.length > 0) {
    lines.push("", labels.sources);
    answer.sources.forEach((source, i) => {
      const kind = source.kind === "meeting" ? labels.meeting : labels.note;
      const when = new Date(source.when * 1000).toLocaleString();
      lines.push(
        `[${i + 1}] ${kind} — ${source.title || labels.untitled} (${when})`,
      );
    });
  }
  lines.push("", labels.footer);
  return lines.join("\n");
}

/** A filename from the question: lowercase words, hyphens, nothing exotic. */
function fileStem(question: string): string {
  const stem = question
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return stem || "ask-answer";
}
