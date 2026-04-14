import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";

interface CustomWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const VOCAB_PRESETS: { id: string; labelKey: string; words: string[] }[] = [
  {
    id: "web",
    labelKey: "settings.advanced.customWords.presets.web",
    words: [
      "React", "Next.js", "TypeScript", "JavaScript", "Tailwind", "shadcn",
      "Vite", "ESLint", "Prettier", "Zustand", "TanStack", "Zod", "tRPC",
      "Vercel", "Supabase", "Prisma", "NextAuth", "pnpm", "npm", "bun",
      "useState", "useEffect", "useMemo", "useCallback", "useRef",
    ],
  },
  {
    id: "rust",
    labelKey: "settings.advanced.customWords.presets.rust",
    words: [
      "Rust", "Cargo", "Tokio", "Serde", "Tauri", "rustc", "clippy",
      "Axum", "Actix", "anyhow", "thiserror", "rustup", "crates.io",
    ],
  },
  {
    id: "python",
    labelKey: "settings.advanced.customWords.presets.python",
    words: [
      "Python", "FastAPI", "Django", "Flask", "pytest", "NumPy", "PyTorch",
      "TensorFlow", "pip", "uv", "poetry", "Pydantic", "pandas", "Jupyter",
    ],
  },
  {
    id: "ai",
    labelKey: "settings.advanced.customWords.presets.ai",
    words: [
      "Cursor", "Claude", "Windsurf", "Cline", "Copilot", "ChatGPT",
      "Anthropic", "OpenAI", "GPT", "Whisper", "MCP", "LLM", "RAG",
      "Ollama", "LangChain",
    ],
  },
];

export const CustomWords: React.FC<CustomWordsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newWord, setNewWord] = useState("");
    const customWords = getSetting("custom_words") || [];

    const handleAddWord = () => {
      const trimmedWord = newWord.trim();
      const sanitizedWord = trimmedWord.replace(/[<>"'&]/g, "");
      if (
        sanitizedWord &&
        !sanitizedWord.includes(" ") &&
        sanitizedWord.length <= 50
      ) {
        if (customWords.includes(sanitizedWord)) {
          toast.error(
            t("settings.advanced.customWords.duplicate", {
              word: sanitizedWord,
            }),
          );
          return;
        }
        updateSetting("custom_words", [...customWords, sanitizedWord]);
        setNewWord("");
      }
    };

    const handleRemoveWord = (wordToRemove: string) => {
      updateSetting(
        "custom_words",
        customWords.filter((word) => word !== wordToRemove),
      );
    };

    const handleAddPreset = (presetId: string) => {
      const preset = VOCAB_PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      const existing = new Set(customWords);
      const toAdd = preset.words.filter((w) => !existing.has(w));
      if (toAdd.length === 0) {
        toast(t("settings.advanced.customWords.presetAlreadyAdded"));
        return;
      }
      updateSetting("custom_words", [...customWords, ...toAdd]);
      toast.success(
        t("settings.advanced.customWords.presetAdded", { count: toAdd.length }),
      );
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddWord();
      }
    };

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.customWords.title")}
          description={t("settings.advanced.customWords.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <div className="flex items-center gap-2">
            <Input
              type="text"
              className="max-w-40"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={t("settings.advanced.customWords.placeholder")}
              variant="compact"
              disabled={isUpdating("custom_words")}
            />
            <Button
              onClick={handleAddWord}
              disabled={
                !newWord.trim() ||
                newWord.includes(" ") ||
                newWord.trim().length > 50 ||
                isUpdating("custom_words")
              }
              variant="primary"
              size="md"
            >
              {t("settings.advanced.customWords.add")}
            </Button>
          </div>
        </SettingContainer>
        <SettingContainer
          title={t("settings.advanced.customWords.presets.title")}
          description={t("settings.advanced.customWords.presets.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
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
          <div
            className={`px-4 p-2 ${grouped ? "" : "rounded-lg border border-mid-gray/20"} flex flex-wrap gap-1`}
          >
            {customWords.map((word) => (
              <Button
                key={word}
                onClick={() => handleRemoveWord(word)}
                disabled={isUpdating("custom_words")}
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1 cursor-pointer"
                aria-label={t("settings.advanced.customWords.remove", { word })}
              >
                <span>{word}</span>
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </Button>
            ))}
          </div>
        )}
      </>
    );
  },
);
