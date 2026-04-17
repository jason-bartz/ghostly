import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Clock,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useSettings } from "../../../hooks/useSettings";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { SettingContainer, SettingsGroup } from "../../ui";
import { CorrectionPhrases } from "../CorrectionPhrases";
import { styleCommands } from "@/lib/styleBindings";
import type { CategoryId } from "../profiles/types";

const CATEGORY_TAGS: Array<{ id: CategoryId; label: string; full: string }> = [
  { id: "personal_messages", label: "P", full: "Personal" },
  { id: "work_messages", label: "W", full: "Work" },
  { id: "email", label: "E", full: "Email" },
  { id: "coding", label: "C", full: "Coding" },
  { id: "other", label: "O", full: "Other" },
];

type DictSort = "recent" | "az" | "za";

const VOCAB_PRESETS: {
  id: string;
  labelKey: string;
  category: CategoryId;
  words: string[];
}[] = [
  {
    id: "web",
    labelKey: "settings.advanced.customWords.presets.web",
    category: "coding",
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
    category: "coding",
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
    category: "coding",
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
    category: "coding",
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
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const customWords =
    (getSetting("custom_words") as string[] | undefined) ?? [];
  const phonetics =
    (getSetting("custom_word_phonetics") as
      | Record<string, string>
      | undefined) ?? {};
  const wordCategories =
    (getSetting("custom_word_categories") as
      | Record<string, CategoryId[]>
      | undefined) ?? {};

  const toggleCategory = async (word: string, category: CategoryId) => {
    const key = word.toLowerCase();
    const current = wordCategories[key] ?? [];
    const next = current.includes(category)
      ? current.filter((c) => c !== category)
      : [...current, category];
    try {
      await styleCommands.setCustomWordCategories(word, next);
      await refreshSettings();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const [newWord, setNewWord] = useState("");
  const [newPhonetic, setNewPhonetic] = useState("");
  const [showPhonetic, setShowPhonetic] = useState(false);

  // List-level controls
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DictSort>("recent");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (word: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  const clearSelection = () => setSelected(new Set());

  const displayedWords = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? customWords.filter((w) => {
          if (w.toLowerCase().includes(q)) return true;
          const p = phonetics[w.toLowerCase()];
          return p ? p.toLowerCase().includes(q) : false;
        })
      : customWords;
    if (sort === "az") return [...filtered].sort((a, b) => a.localeCompare(b));
    if (sort === "za") return [...filtered].sort((a, b) => b.localeCompare(a));
    return filtered; // "recent" — storage order (newest first because we prepend)
  }, [customWords, phonetics, query, sort]);

  const allVisibleSelected =
    displayedWords.length > 0 &&
    displayedWords.every((w) => selected.has(w));
  const anyVisibleSelected = displayedWords.some((w) => selected.has(w));
  const toggleSelectAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        displayedWords.forEach((w) => next.delete(w));
      } else {
        displayedWords.forEach((w) => next.add(w));
      }
      return next;
    });

  const handleBulkDelete = () => {
    if (selected.size === 0) return;
    const remaining = customWords.filter((w) => !selected.has(w));
    updateSetting("custom_words", remaining);
    const nextPhonetics = { ...phonetics };
    let touched = false;
    for (const w of selected) {
      const key = w.toLowerCase();
      if (key in nextPhonetics) {
        delete nextPhonetics[key];
        touched = true;
      }
    }
    if (touched) updateSetting("custom_word_phonetics", nextPhonetics);
    clearSelection();
  };

  const handleAdd = () => {
    const word = sanitizeWord(newWord);
    if (!word || word.includes(" ") || word.length > MAX_WORD_LEN) return;
    if (customWords.some((w) => w.toLowerCase() === word.toLowerCase())) {
      toast.error(t("settings.advanced.customWords.duplicate", { word }));
      return;
    }
    // Prepend so the newest addition is visible at the top of the list.
    updateSetting("custom_words", [word, ...customWords]);
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
    setSelected((prev) => {
      if (!prev.has(word)) return prev;
      const next = new Set(prev);
      next.delete(word);
      return next;
    });
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

  const handleAddPreset = async (presetId: string) => {
    const preset = VOCAB_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const existing = new Set(customWords.map((w) => w.toLowerCase()));
    const toAdd = preset.words.filter((w) => !existing.has(w.toLowerCase()));

    // Scope preset words to their category (e.g. "coding") so they only
    // activate when the frontmost app matches that category — prevents
    // "next week" → "Next.js" and "pricing" → "Prisma" in Superhuman,
    // Messages, browser, etc. Tag every preset word, including ones the
    // user already has — re-clicking the preset backfills the category
    // on existing untagged words. Preserve any other tags the user set
    // manually.
    const needsTag = preset.words.filter((w) => {
      const current = wordCategories[w.toLowerCase()] ?? [];
      return !current.includes(preset.category);
    });

    if (toAdd.length === 0 && needsTag.length === 0) {
      toast(t("settings.advanced.customWords.presetAlreadyAdded"));
      return;
    }

    if (toAdd.length > 0) {
      updateSetting("custom_words", [...toAdd, ...customWords]);
    }

    try {
      for (const w of needsTag) {
        const current = wordCategories[w.toLowerCase()] ?? [];
        await styleCommands.setCustomWordCategories(w, [
          ...current,
          preset.category,
        ]);
      }
      await refreshSettings();
    } catch (e) {
      toast.error(String(e));
      return;
    }

    toast.success(
      t("settings.advanced.customWords.presetAdded", {
        count: toAdd.length || needsTag.length,
      }),
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
        updateSetting("custom_words", [...newWords, ...customWords]);
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
          <div className="px-4 py-3 flex flex-col gap-2">
            {/* Toolbar: search + sort */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mid-gray/60 pointer-events-none" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t(
                    "settings.dictionary.vocabulary.searchPlaceholder",
                    "Search words…",
                  )}
                  className="w-full h-8 pl-9 pr-8 text-sm bg-background border border-mid-gray/30 rounded-md
                             focus:outline-none focus:border-logo-primary/60 placeholder:text-mid-gray/40"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-mid-gray/50 hover:text-mid-gray"
                    aria-label={t(
                      "settings.dictionary.vocabulary.clearSearch",
                      "Clear search",
                    )}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="relative">
                {sort === "recent" ? (
                  <Clock className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mid-gray/60 pointer-events-none" />
                ) : sort === "az" ? (
                  <ArrowDownAZ className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mid-gray/60 pointer-events-none" />
                ) : (
                  <ArrowUpAZ className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-mid-gray/60 pointer-events-none" />
                )}
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as DictSort)}
                  className="h-8 pl-7 pr-2 bg-background border border-mid-gray/30 rounded-md text-sm
                             focus:outline-none focus:border-logo-primary/60 cursor-pointer appearance-none"
                  title={t("settings.dictionary.vocabulary.sort", "Sort")}
                >
                  <option value="recent">
                    {t(
                      "settings.dictionary.vocabulary.sortRecent",
                      "Most recent",
                    )}
                  </option>
                  <option value="az">
                    {t("settings.dictionary.vocabulary.sortAZ", "A → Z")}
                  </option>
                  <option value="za">
                    {t("settings.dictionary.vocabulary.sortZA", "Z → A")}
                  </option>
                </select>
              </div>
            </div>

            {/* Category key — explains the P/W/E/O tags on each row */}
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-mid-gray/80"
              title={t("settings.dictionary.tags.legendHint")}
            >
              <span className="font-medium text-text/70">
                {t("settings.dictionary.tags.legendLabel", "Scope:")}
              </span>
              {CATEGORY_TAGS.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1">
                  <span className="w-4 h-4 inline-flex items-center justify-center text-[10px] font-semibold rounded bg-mid-gray/15 text-text/70">
                    {c.label}
                  </span>
                  <span>{t(`settings.dictionary.tags.${c.id}`, c.full)}</span>
                </span>
              ))}
              <span className="text-mid-gray/60">
                {t(
                  "settings.dictionary.tags.legendHint",
                  "Click a tag to limit a word to that context. Unset = applies everywhere.",
                )}
              </span>
            </div>

            {/* Bulk action bar */}
            {selected.size > 0 && (
              <div className="flex items-center gap-2 px-3 h-10 rounded-md border border-logo-primary/40 bg-logo-primary/10 text-sm">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el)
                        el.indeterminate =
                          !allVisibleSelected && anyVisibleSelected;
                    }}
                    onChange={toggleSelectAllVisible}
                    className="w-4 h-4 accent-logo-primary cursor-pointer"
                  />
                  <span className="font-medium text-logo-primary">
                    {t(
                      "settings.dictionary.vocabulary.selectedCount",
                      "{{count}} selected",
                      { count: selected.size },
                    )}
                  </span>
                </label>
                <div className="flex-1" />
                <button
                  onClick={handleBulkDelete}
                  className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t("settings.advanced.customWords.remove_short", "Delete")}
                </button>
                <button
                  onClick={clearSelection}
                  className="flex items-center justify-center w-7 h-7 rounded-md text-text/60 hover:text-text hover:bg-mid-gray/20 transition-colors cursor-pointer"
                  title={t(
                    "settings.dictionary.vocabulary.clearSelection",
                    "Clear selection",
                  )}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* List */}
            {displayedWords.length === 0 ? (
              <p className="text-sm text-mid-gray/70 py-1">
                {query
                  ? t(
                      "settings.dictionary.vocabulary.noMatches",
                      "No words match your search.",
                    )
                  : t(
                      "settings.dictionary.vocabulary.empty",
                      "No words yet.",
                    )}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {displayedWords.map((word) => {
                  const phoneticValue = phonetics[word.toLowerCase()] ?? "";
                  const isSelected = selected.has(word);
                  const selectionActive = selected.size > 0;
                  return (
                    <div
                      key={word}
                      className={`group/row flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors ${
                        isSelected ? "bg-logo-primary/10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(word)}
                        className={`w-4 h-4 accent-logo-primary cursor-pointer shrink-0 transition-opacity ${
                          selectionActive || isSelected
                            ? "opacity-100"
                            : "opacity-0 group-hover/row:opacity-100 focus:opacity-100"
                        }`}
                        aria-label={t(
                          "settings.dictionary.vocabulary.selectWord",
                          "Select word",
                        )}
                      />
                      <span className="text-sm font-medium min-w-32 truncate">
                        {word}
                      </span>
                      {/* Category tags — default (none selected) = applies
                          everywhere. Click to scope to specific categories. */}
                      <CategoryTagToggle
                        word={word}
                        selected={wordCategories[word.toLowerCase()] ?? []}
                        onToggle={(cat) => toggleCategory(word, cat)}
                      />
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
                        className="text-mid-gray/50 hover:text-red-400 transition-colors opacity-0 group-hover/row:opacity-100"
                        title={t("settings.advanced.customWords.remove", {
                          word,
                        })}
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
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.correctionPhrases.title")}>
        <CorrectionPhrases />
      </SettingsGroup>
    </div>
  );
};

interface CategoryTagToggleProps {
  word: string;
  selected: CategoryId[];
  onToggle: (c: CategoryId) => void;
}

const CategoryTagToggle: React.FC<CategoryTagToggleProps> = ({
  word,
  selected,
  onToggle,
}) => {
  const { t } = useTranslation();
  const hasAny = selected.length > 0;
  return (
    <div
      className="flex items-center gap-0.5"
      title={
        hasAny
          ? t("settings.dictionary.tags.scoped", {
              cats: selected
                .map(
                  (id) =>
                    CATEGORY_TAGS.find((c) => c.id === id)?.full ?? id,
                )
                .join(", "),
            })
          : t("settings.dictionary.tags.global", "Applies everywhere")
      }
    >
      {CATEGORY_TAGS.map((c) => {
        const active = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(c.id);
            }}
            className={`w-5 h-5 text-[10px] font-semibold rounded-md transition-colors shrink-0 ${
              active
                ? "bg-logo-primary text-white"
                : hasAny
                  ? "bg-mid-gray/20 text-text/40 hover:text-text/70"
                  : "bg-mid-gray/10 text-text/40 hover:bg-mid-gray/25 hover:text-text/70"
            }`}
            aria-label={`${word} — ${c.full}`}
            aria-pressed={active}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
};
