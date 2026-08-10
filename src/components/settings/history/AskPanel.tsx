import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { commands, type AskAnswer } from "@/bindings";
import { Button } from "../../ui/Button";

/**
 * Ask a question of everything you have ever dictated.
 *
 * Collapsed to a single line until used. This pane's job is browsing notes;
 * an always-open answer box would push the notes themselves below the fold to
 * serve a thing most visits don't need.
 *
 * The privacy line under the box is not decoration. Search happens against the
 * local SQLite indexes and only the matching passages are sent — that is the
 * difference between this and every hosted "chat with your notes" product, and
 * it is worth one sentence of screen space.
 */
export const AskPanel: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await commands.askTranscripts(q);
      if (res.status === "ok") {
        setAnswer(res.data);
      } else {
        setError(String(res.error));
      }
    } finally {
      setBusy(false);
    }
  }, [question, busy]);

  const reset = () => {
    setAnswer(null);
    setError(null);
    setQuestion("");
    inputRef.current?.focus();
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // The input mounts with this click, so focus on the next frame.
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="flex items-center gap-2 h-8 px-3 rounded-md border border-hairline-strong
                   bg-fill-1 text-sm text-text-muted hover:text-text hover:bg-fill-2
                   transition-colors self-start"
      >
        <Sparkles className="w-4 h-4 text-accent-bright" aria-hidden />
        {t("ask.open")}
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-hairline-strong bg-fill-1 overflow-hidden">
      <div className="flex items-center gap-2 p-2">
        <Sparkles
          className="w-4 h-4 shrink-0 ml-1 text-accent-bright"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={t("ask.placeholder")}
          disabled={busy}
          className="flex-1 min-w-0 h-8 bg-transparent text-sm focus:outline-none
                     placeholder:text-text-faint disabled:opacity-60"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submit()}
          disabled={busy || question.trim().length === 0}
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            t("ask.submit")
          )}
        </Button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("common.close", "Close")}
          className="p-1.5 text-text-faint hover:text-text-muted"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {answer === null && error === null && !busy && (
        <p className="px-4 pb-3 text-xs text-text-faint leading-snug">
          {t("ask.privacyNote")}
        </p>
      )}

      {error !== null && (
        <div className="border-t border-hairline px-4 py-3">
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      {answer !== null && (
        <div className="border-t border-hairline px-4 py-3 space-y-3">
          <p
            className={`text-sm leading-relaxed whitespace-pre-wrap ${
              answer.no_matches ? "text-text-muted" : "text-text"
            }`}
          >
            {answer.answer}
          </p>

          {answer.sources.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">
                {t("ask.sources", { count: answer.sources.length })}
              </p>
              {answer.sources.map((s, i) => (
                <div
                  key={`${s.kind}-${s.id}-${i}`}
                  className="flex items-start gap-2 text-xs text-text-muted"
                >
                  <span className="shrink-0 tabular-nums text-text-faint">
                    [{i + 1}]
                  </span>
                  <span className="shrink-0 tag">
                    {s.kind === "meeting" ? t("ask.meeting") : t("ask.note")}
                  </span>
                  <span className="min-w-0">
                    <span className="text-text">
                      {s.title || t("ask.untitled")}
                    </span>
                    <span className="text-text-faint">
                      {" · "}
                      {new Date(s.when * 1000).toLocaleDateString()}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text"
          >
            <Search className="w-3.5 h-3.5" aria-hidden />
            {t("ask.askAnother")}
          </button>
        </div>
      )}
    </div>
  );
};
