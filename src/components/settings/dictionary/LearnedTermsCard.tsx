import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { GraduationCap } from "lucide-react";
import { commands, type LearnedTerm } from "@/bindings";

/**
 * What Ghostly worked out for itself this week.
 *
 * Renders nothing when there is nothing — a permanent "learned 0 terms" panel
 * would advertise the feature failing. It appears the first week it has
 * something to say, which is also when it is most convincing.
 */
export const LearnedTermsCard: React.FC = () => {
  const { t } = useTranslation();
  const [terms, setTerms] = useState<LearnedTerm[]>([]);

  const load = useCallback(async () => {
    const res = await commands.getRecentlyLearned();
    if (res.status === "ok") setTerms(res.data);
  }, []);

  useEffect(() => {
    void load();
    // The daily pass runs while the app is open, so the card would otherwise
    // stay stale until the pane was reopened.
    const unlisten = listen("vocabulary-learned", () => void load());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [load]);

  if (terms.length === 0) return null;

  return (
    <div className="surface-card rounded-xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <GraduationCap
          className="h-5 w-5 shrink-0 text-accent-bright mt-0.5"
          aria-hidden
        />
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            {t("dictionary.learned.title", { count: terms.length })}
          </p>
          <p className="text-sm text-mid-gray leading-relaxed">
            {t("dictionary.learned.description")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {terms.map((term) => (
          <span
            key={`${term.wrong}-${term.correct}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong
                       bg-fill-2 px-2 py-1 text-xs"
            title={t("dictionary.learned.pair", {
              wrong: term.wrong,
              correct: term.correct,
            })}
          >
            <span className="text-text-faint line-through">{term.wrong}</span>
            <span className="text-text-faint" aria-hidden>
              →
            </span>
            <span className="text-text">{term.correct}</span>
          </span>
        ))}
      </div>

      <p className="text-xs text-mid-gray/70 leading-relaxed">
        {t("dictionary.learned.editHint")}
      </p>
    </div>
  );
};
