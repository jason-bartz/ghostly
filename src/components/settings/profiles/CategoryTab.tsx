import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";
import { StyleCard } from "./StyleCard";
import { STYLE_SAMPLES } from "./styleSamples";
import type {
  CategoryId,
  CategoryStyleLike,
  StyleId,
} from "./types";
import { styleCommands } from "@/lib/styleBindings";
import { STYLE_CATEGORY_APPS } from "@/lib/appIcons";

interface CategoryTabProps {
  category: CategoryId;
  style: CategoryStyleLike;
  onChanged: (next: CategoryStyleLike[]) => void;
}

const PRESET_STYLES: Array<{ id: StyleId; titleKey: string; subKey: string }> = [
  {
    id: "formal",
    titleKey: "settings.style.presets.formal.title",
    subKey: "settings.style.presets.formal.subtitle",
  },
  {
    id: "casual",
    titleKey: "settings.style.presets.casual.title",
    subKey: "settings.style.presets.casual.subtitle",
  },
  {
    id: "excited",
    titleKey: "settings.style.presets.excited.title",
    subKey: "settings.style.presets.excited.subtitle",
  },
];

export const CategoryTab: React.FC<CategoryTabProps> = ({
  category,
  style,
  onChanged,
}) => {
  const { t } = useTranslation();
  const [newWord, setNewWord] = useState("");
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState({
    name: style.custom_style_name ?? "",
    prompt: style.custom_style_prompt ?? "",
  });

  const apps = STYLE_CATEGORY_APPS[category] ?? [];
  const samples = STYLE_SAMPLES[category];

  const pickPreset = async (id: StyleId) => {
    try {
      const next = await styleCommands.setCategoryStyle(category, id);
      onChanged(next);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const pickCustom = async () => {
    try {
      const next = await styleCommands.setCategoryStyle(category, "custom");
      onChanged(next);
      setCustomEditorOpen(true);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const saveCustom = async () => {
    try {
      await styleCommands.setCategoryCustomStyleName(
        category,
        customDraft.name.trim() || null,
      );
      const next = await styleCommands.setCategoryCustomPrompt(
        category,
        customDraft.prompt.trim() || null,
      );
      onChanged(next);
      setCustomEditorOpen(false);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const addVocab = async () => {
    const word = newWord.trim().replace(/[<>"'&]/g, "");
    if (!word) return;
    if (
      style.custom_vocab.some((w) => w.toLowerCase() === word.toLowerCase())
    ) {
      toast.error(t("settings.style.vocab.duplicate"));
      return;
    }
    try {
      const next = await styleCommands.setCategoryVocab(category, [
        ...style.custom_vocab,
        word,
      ]);
      onChanged(next);
      setNewWord("");
    } catch (e) {
      toast.error(String(e));
    }
  };

  const removeVocab = async (word: string) => {
    try {
      const next = await styleCommands.setCategoryVocab(
        category,
        style.custom_vocab.filter((w) => w !== word),
      );
      onChanged(next);
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="space-y-5">
      {/* Applies-in header strip */}
      <div className="rounded-xl bg-gradient-to-r from-logo-primary/15 via-logo-primary/5 to-transparent border border-logo-primary/20 px-4 py-3 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {t(`settings.style.appliesIn.${category}`)}
          </div>
          <div className="text-xs text-text/60 mt-0.5">
            {t("settings.style.appliesInHint")}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {apps.map((a) => (
            <img
              key={a.label}
              src={a.icon}
              alt={a.label}
              title={a.label}
              className="w-7 h-7 rounded-md"
            />
          ))}
          {apps.length === 0 && (
            <span className="text-xs text-text/50 italic">
              {t("settings.style.appliesIn.otherHint")}
            </span>
          )}
        </div>
      </div>

      {/* Style cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {PRESET_STYLES.map((p) => (
          <StyleCard
            key={p.id}
            title={t(p.titleKey)}
            subtitle={t(p.subKey)}
            sample={samples[p.id as Exclude<StyleId, "custom">]}
            selected={style.selected_style === p.id}
            onSelect={() => pickPreset(p.id)}
          />
        ))}
        <StyleCard
          title={style.custom_style_name || t("settings.style.presets.custom.title")}
          subtitle={t("settings.style.presets.custom.subtitle")}
          sample={
            style.custom_style_prompt?.trim() ||
            t("settings.style.presets.custom.empty")
          }
          selected={style.selected_style === "custom"}
          onSelect={pickCustom}
          action={
            style.selected_style === "custom" && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setCustomDraft({
                    name: style.custom_style_name ?? "",
                    prompt: style.custom_style_prompt ?? "",
                  });
                  setCustomEditorOpen(true);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-logo-primary hover:underline cursor-pointer"
                role="button"
                tabIndex={0}
              >
                <Pencil className="w-3 h-3" />
                {t("settings.style.presets.custom.edit")}
              </span>
            )
          }
        />
      </div>

      {/* Custom style editor */}
      {customEditorOpen && (
        <div className="rounded-xl border border-mid-gray/25 bg-mid-gray/5 p-4">
          <div className="text-sm font-semibold mb-4">
            {t("settings.style.custom.editorTitle")}
          </div>

          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text/80">
                {t("settings.style.custom.nameLabel")}
              </span>
              <Input
                type="text"
                placeholder={t("settings.style.custom.namePlaceholder")}
                value={customDraft.name}
                onChange={(e) =>
                  setCustomDraft((d) => ({ ...d, name: e.target.value }))
                }
                variant="compact"
                className="w-full"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text/80">
                {t("settings.style.custom.promptLabel")}
              </span>
              <Textarea
                placeholder={t("settings.style.custom.promptPlaceholder")}
                value={customDraft.prompt}
                onChange={(e) =>
                  setCustomDraft((d) => ({ ...d, prompt: e.target.value }))
                }
                rows={6}
                className="w-full"
              />
              <span className="text-xs text-text/60">
                {t("settings.style.custom.promptHint")}
              </span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-mid-gray/15">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setCustomEditorOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={saveCustom}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {/* Category vocabulary */}
      <div className="rounded-xl border border-mid-gray/20 bg-mid-gray/5 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">
              {t("settings.style.vocab.title")}
            </div>
            <div className="text-xs text-text/60 mt-0.5">
              {t("settings.style.vocab.hint")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addVocab();
              }
            }}
            placeholder={t("settings.style.vocab.placeholder")}
            variant="compact"
            className="flex-1 max-w-xs"
          />
          <Button variant="secondary" size="sm" onClick={addVocab}>
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <Plus className="w-4 h-4" />
              <span>{t("common.add")}</span>
            </span>
          </Button>
        </div>
        {style.custom_vocab.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {style.custom_vocab.map((w) => (
              <span
                key={w}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-mid-gray/25 bg-background text-xs"
              >
                <span>{w}</span>
                <button
                  type="button"
                  onClick={() => removeVocab(w)}
                  className="text-text/50 hover:text-red-400"
                  aria-label={t("common.remove")}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
