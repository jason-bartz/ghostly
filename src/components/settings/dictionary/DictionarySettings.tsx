import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Upload, X } from "lucide-react";
import { useSettings } from "../../../hooks/useSettings";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { SettingContainer, SettingsGroup } from "../../ui";
import { CorrectionPhrases } from "../CorrectionPhrases";

const VOCAB_PRESETS: { id: string; labelKey: string; words: string[] }[] = [
  {
    id: "web",
    labelKey: "settings.advanced.customWords.presets.web",
    words: [
      "React",
      "Next.js",
      "TypeScript",
      "JavaScript",
      "Tailwind",
      "shadcn",
      "Vite",
      "ESLint",
      "Prettier",
      "Zustand",
      "TanStack",
      "Zod",
      "tRPC",
      "Vercel",
      "Supabase",
      "Prisma",
      "NextAuth",
      "pnpm",
      "npm",
      "bun",
    ],
  },
  {
    id: "rust",
    labelKey: "settings.advanced.customWords.presets.rust",
    words: [
      "Rust",
      "Cargo",
      "Tokio",
      "Serde",
      "Tauri",
      "rustc",
      "clippy",
      "Axum",
      "Actix",
      "anyhow",
      "thiserror",
      "rustup",
    ],
  },
  {
    id: "python",
    labelKey: "settings.advanced.customWords.presets.python",
    words: [
      "Python",
      "FastAPI",
      "Django",
      "Flask",
      "pytest",
      "NumPy",
      "PyTorch",
      "TensorFlow",
      "pip",
      "uv",
      "poetry",
      "Pydantic",
      "pandas",
      "Jupyter",
    ],
  },
  {
    id: "ai",
    labelKey: "settings.advanced.customWords.presets.ai",
    words: [
      "Cursor",
      "Claude",
      "Windsurf",
      "Cline",
      "Copilot",
      "ChatGPT",
      "Anthropic",
      "OpenAI",
      "GPT",
      "Whisper",
      "MCP",
      "LLM",
      "RAG",
      "Ollama",
      "LangChain",
    ],
  },
];

const MAX_WORD_LEN = 50;

/** Strip chars that would break the settings store or confuse Whisper's prompt. */
const sanitizeWord = (raw: string) => raw.trim().replace(/[<>"'&]/g, "");

/** Parse a pasted/uploaded CSV or newline-delimited list.
 *  Accepts: "word" per line, or "word,phonetic" per line.
 *  Returns pairs; phonetic is undefined when absent. */
type ParsedRow = { word: string; phonetic?: string };

const parseCsv = (text: string): ParsedRow[] => {
  const rows: ParsedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [wordRaw, phoneticRaw] = line.split(",");
    const word = sanitizeWord(wordRaw ?? "");
    if (!word || word.includes(" ") || word.length > MAX_WORD_LEN) continue;
    const phonetic = phoneticRaw?.trim();
    rows.push(phonetic ? { word, phonetic } : { word });
  }
  return rows;
};

export const DictionarySettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const customWords =
    (getSetting("custom_words") as string[] | undefined) ?? [];
  const phonetics =
    (getSetting("custom_word_phonetics") as
      | Record<string, string>
      | undefined) ?? {};

  const [newWord, setNewWord] = useState("");
  const [newPhonetic, setNewPhonetic] = useState("");
  const [showPhonetic, setShowPhonetic] = useState(false);

  const handleAdd = () => {
    const word = sanitizeWord(newWord);
    if (!word || word.includes(" ") || word.length > MAX_WORD_LEN) return;
    if (customWords.some((w) => w.toLowerCase() === word.toLowerCase())) {
      toast.error(t("settings.advanced.customWords.duplicate", { word }));
      return;
    }
    updateSetting("custom_words", [...customWords, word]);
    const phoneticTrim = newPhonetic.trim();
    if (phoneticTrim) {
      updateSetting("custom_word_phonetics", {
        ...phonetics,
        [word.toLowerCase()]: phoneticTrim,
      });
    }
    setNewWord("");
    setNewPhonetic("");
  };

  const handleRemove = (word: string) => {
    updateSetting(
      "custom_words",
      customWords.filter((w) => w !== word),
    );
    // Drop any phonetic entry for this word.
    const key = word.toLowerCase();
    if (key in phonetics) {
      const { [key]: _removed, ...rest } = phonetics;
      updateSetting("custom_word_phonetics", rest);
    }
  };

  const handleUpdatePhonetic = (word: string, value: string) => {
    const key = word.toLowerCase();
    const trimmed = value.trim();
    const next = { ...phonetics };
    if (trimmed) {
      next[key] = trimmed;
    } else {
      delete next[key];
    }
    updateSetting("custom_word_phonetics", next);
  };

  const handleAddPreset = (presetId: string) => {
    const preset = VOCAB_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const existing = new Set(customWords.map((w) => w.toLowerCase()));
    const toAdd = preset.words.filter((w) => !existing.has(w.toLowerCase()));
    if (toAdd.length === 0) {
      toast(t("settings.advanced.customWords.presetAlreadyAdded"));
      return;
    }
    updateSetting("custom_words", [...customWords, ...toAdd]);
    toast.success(
      t("settings.advanced.customWords.presetAdded", { count: toAdd.length }),
    );
  };

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.length === 0) {
        toast.error(t("settings.dictionary.csv.empty"));
        return;
      }
      const existing = new Set(customWords.map((w) => w.toLowerCase()));
      const newWords: string[] = [];
      const newPhonetics: Record<string, string> = { ...phonetics };
      for (const { word, phonetic } of parsed) {
        if (!existing.has(word.toLowerCase())) {
          newWords.push(word);
          existing.add(word.toLowerCase());
        }
        if (phonetic) {
          newPhonetics[word.toLowerCase()] = phonetic;
        }
      }
      if (newWords.length === 0 && !parsed.some((p) => p.phonetic)) {
        toast(t("settings.dictionary.csv.nothingNew"));
      } else {
        updateSetting("custom_words", [...customWords, ...newWords]);
        updateSetting("custom_word_phonetics", newPhonetics);
        toast.success(
          t("settings.dictionary.csv.imported", {
            count: newWords.length,
            total: parsed.length,
          }),
        );
      }
    } catch {
      toast.error(t("settings.dictionary.csv.failed"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup
        title={t("settings.dictionary.vocabulary.title", "Vocabulary")}
      >
        <SettingContainer
          title={t(
            "settings.dictionary.vocabulary.addTitle",
            "Words to recognize",
          )}
          description={t(
            "settings.dictionary.vocabulary.addDescription",
            "Unique words Ghostly should learn — proper nouns, brand names, acronyms, jargon. No spaces; one word per entry.",
          )}
          descriptionMode="tooltip"
          grouped
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                className="flex-1 min-w-40"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder={t("settings.advanced.customWords.placeholder")}
                variant="compact"
                disabled={isUpdating("custom_words")}
              />
              {showPhonetic && (
                <Input
                  type="text"
                  className="flex-1 min-w-40"
                  value={newPhonetic}
                  onChange={(e) => setNewPhonetic(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder={t(
                    "settings.dictionary.vocabulary.phoneticPlaceholder",
                    "Pronounced like (optional)",
                  )}
                  variant="compact"
                />
              )}
              <Button
                onClick={handleAdd}
                disabled={
                  !newWord.trim() ||
                  newWord.includes(" ") ||
                  newWord.trim().length > MAX_WORD_LEN ||
                  isUpdating("custom_words")
                }
                variant="primary"
                size="md"
              >
                {t("settings.advanced.customWords.add")}
              </Button>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => setShowPhonetic((s) => !s)}
                className="text-mid-gray hover:text-text transition-colors underline-offset-2 hover:underline"
              >
                {showPhonetic
                  ? t(
                      "settings.dictionary.vocabulary.hidePhonetic",
                      "Hide pronunciation field",
                    )
                  : t(
                      "settings.dictionary.vocabulary.showPhonetic",
                      "Add pronunciation hint",
                    )}
              </button>
              <span className="text-mid-gray/40">·</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 text-mid-gray hover:text-text transition-colors underline-offset-2 hover:underline"
              >
                <Upload className="w-3 h-3" />
                {t("settings.dictionary.csv.button", "Upload CSV")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={handleCsvUpload}
              />
            </div>
          </div>
        </SettingContainer>

        <SettingContainer
          title={t("settings.advanced.customWords.presets.title")}
          description={t("settings.advanced.customWords.presets.description")}
          descriptionMode="tooltip"
          grouped
        >
          <div className="flex flex-wrap gap-2">
            {VOCAB_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                onClick={() => handleAddPreset(preset.id)}
                disabled={isUpdating("custom_words")}
                variant="secondary"
                size="sm"
              >
                {t(preset.labelKey)}
              </Button>
            ))}
          </div>
        </SettingContainer>

        {customWords.length > 0 && (
          <div className="px-4 py-3 space-y-1.5">
            {customWords.map((word) => {
              const phoneticValue = phonetics[word.toLowerCase()] ?? "";
              return (
                <div key={word} className="flex items-center gap-2 group">
                  <span className="text-sm font-medium min-w-32 truncate">
                    {word}
                  </span>
                  {showPhonetic ? (
                    <Input
                      type="text"
                      className="flex-1"
                      value={phoneticValue}
                      onChange={(e) =>
                        handleUpdatePhonetic(word, e.target.value)
                      }
                      placeholder={t(
                        "settings.dictionary.vocabulary.phoneticPlaceholder",
                        "Pronounced like (optional)",
                      )}
                      variant="compact"
                    />
                  ) : phoneticValue ? (
                    <span className="flex-1 text-xs text-mid-gray italic truncate">
                      {t(
                        "settings.dictionary.vocabulary.soundsLike",
                        "sounds like",
                      )}{" "}
                      “{phoneticValue}”
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <button
                    onClick={() => handleRemove(word)}
                    className="text-mid-gray/50 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                    title={t("settings.advanced.customWords.remove", { word })}
                    aria-label={t("settings.advanced.customWords.remove", {
                      word,
                    })}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.correctionPhrases.title")}>
        <CorrectionPhrases />
      </SettingsGroup>
    </div>
  );
};
