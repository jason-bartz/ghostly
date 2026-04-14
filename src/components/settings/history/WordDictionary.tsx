import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import { toast } from "sonner";
import { commands, type WordCorrection } from "@/bindings";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";

export const WordDictionary: React.FC = () => {
  const { t } = useTranslation();
  const [corrections, setCorrections] = useState<WordCorrection[]>([]);
  const [loading, setLoading] = useState(true);
  const [draftWrong, setDraftWrong] = useState("");
  const [draftCorrect, setDraftCorrect] = useState("");
  const [adding, setAdding] = useState(false);

  const load = async () => {
    try {
      const result = await commands.getWordCorrections();
      if (result.status === "ok") {
        setCorrections(result.data);
      }
    } catch (error) {
      console.error("Failed to load word corrections:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async () => {
    if (!draftWrong.trim() || !draftCorrect.trim()) return;
    setAdding(true);
    try {
      const result = await commands.upsertWordCorrection(
        draftWrong.trim(),
        draftCorrect.trim(),
      );
      if (result.status === "ok") {
        setCorrections((prev) => {
          const existing = prev.findIndex((c) => c.id === result.data.id);
          if (existing >= 0) {
            return prev.map((c) => (c.id === result.data.id ? result.data : c));
          }
          return [result.data, ...prev];
        });
        setDraftWrong("");
        setDraftCorrect("");
      } else {
        toast.error(String(result.error));
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setAdding(false);
    }
  };

  const handleToggle = async (id: number) => {
    setCorrections((prev) =>
      prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
    );
    try {
      const result = await commands.toggleWordCorrection(id);
      if (result.status !== "ok") {
        setCorrections((prev) =>
          prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
        );
      }
    } catch (error) {
      setCorrections((prev) =>
        prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)),
      );
    }
  };

  const handleDelete = async (id: number) => {
    setCorrections((prev) => prev.filter((c) => c.id !== id));
    try {
      const result = await commands.deleteWordCorrection(id);
      if (result.status !== "ok") {
        load();
      }
    } catch {
      load();
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">
          {t("settings.history.dictionary.title", "Word Dictionary")}
        </h3>
        <p className="text-xs text-mid-gray/60 mt-0.5">
          {t(
            "settings.history.dictionary.description",
            "Automatically correct words or phrases in every transcription.",
          )}
        </p>
      </div>

      {/* Add new correction */}
      <div className="flex gap-2 items-center">
        <Input
          type="text"
          value={draftWrong}
          onChange={(e) => setDraftWrong(e.target.value)}
          placeholder={t(
            "settings.history.dictionary.wrong",
            "Mistranscribed word",
          )}
          variant="compact"
          className="flex-1"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <span className="text-mid-gray/60 text-sm">→</span>
        <Input
          type="text"
          value={draftCorrect}
          onChange={(e) => setDraftCorrect(e.target.value)}
          placeholder={t("settings.history.dictionary.correct", "Correct word")}
          variant="compact"
          className="flex-1"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Button
          onClick={handleAdd}
          variant="primary"
          size="sm"
          disabled={!draftWrong.trim() || !draftCorrect.trim() || adding}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Corrections list */}
      {loading ? (
        <p className="text-sm text-mid-gray/60">
          {t("settings.history.loading")}
        </p>
      ) : corrections.length === 0 ? (
        <p className="text-sm text-mid-gray/50 italic">
          {t("settings.history.dictionary.empty", "No corrections yet.")}
        </p>
      ) : (
        <div className="divide-y divide-mid-gray/15 border border-mid-gray/20 rounded-md overflow-hidden">
          {corrections.map((c) => (
            <div
              key={c.id}
              className={`flex items-center gap-2 px-3 py-2 ${
                c.enabled ? "bg-background" : "bg-mid-gray/5"
              }`}
            >
              <span
                className={`text-sm flex-1 truncate ${
                  c.enabled ? "text-text/90" : "text-text/40 line-through"
                }`}
              >
                {c.wrong}
              </span>
              <span className="text-mid-gray/50 text-sm">→</span>
              <span
                className={`text-sm flex-1 truncate ${
                  c.enabled ? "text-text/90" : "text-text/40"
                }`}
              >
                {c.correct}
              </span>
              <button
                onClick={() => handleToggle(c.id)}
                className="text-mid-gray/50 hover:text-logo-primary transition-colors"
                title={
                  c.enabled
                    ? t("settings.history.dictionary.disable", "Disable")
                    : t("settings.history.dictionary.enable", "Enable")
                }
              >
                {c.enabled ? (
                  <ToggleRight className="w-4 h-4 text-logo-primary" />
                ) : (
                  <ToggleLeft className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={() => handleDelete(c.id)}
                className="text-mid-gray/50 hover:text-red-400 transition-colors"
                title={t("settings.history.dictionary.delete", "Delete")}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
