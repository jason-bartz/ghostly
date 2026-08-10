import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";
import { StylePicker, type StyleOption } from "./StylePicker";
import { SectionLabel } from "./SectionLabel";
import { STYLE_SAMPLES } from "./styleSamples";
import type { CategoryId, CategoryStyleLike, StyleId } from "./types";
import { styleCommands } from "@/lib/styleBindings";
import { STYLE_CATEGORY_APPS } from "@/lib/appIcons";

interface CategoryTabProps {
  category: CategoryId;
  style: CategoryStyleLike;
  onChanged: (next: CategoryStyleLike[]) => void;
}

const PRESET_STYLES: Array<{
  id: Exclude<StyleId, "custom">;
  titleKey: string;
  subKey: string;
}> = [
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

  const openCustomEditor = () => {
    setCustomDraft({
      name: style.custom_style_name ?? "",
      prompt: style.custom_style_prompt ?? "",
    });
    setCustomEditorOpen(true);
  };

  const pickStyle = async (id: string) => {
    try {
      const next = await styleCommands.setCategoryStyle(
        category,
        id as StyleId,
      );
      onChanged(next);
      // Picking "Custom" with nothing written yet is a dead end unless the
      // editor comes with it.
      if (id === "custom" && !style.custom_style_prompt?.trim()) {
        openCustomEditor();
      }
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

  const options: StyleOption[] = useMemo(
    () => [
      ...PRESET_STYLES.map((p) => ({
        id: p.id,
        title: t(p.titleKey),
        subtitle: t(p.subKey),
        sample: samples[p.id],
      })),
      {
        id: "custom",
        title:
          style.custom_style_name || t("settings.style.presets.custom.title"),
        subtitle: t("settings.style.presets.custom.subtitle"),
        sample: style.custom_style_prompt?.trim() ? (
          style.custom_style_prompt
        ) : (
          <span className="text-text-muted italic">
            {t("settings.style.presets.custom.empty")}
          </span>
        ),
        action: style.selected_style === "custom" && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              openCustomEditor();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                openCustomEditor();
              }
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium text-accent-bright hover:bg-accent/10 transition-colors cursor-pointer"
          >
            <Pencil className="w-3 h-3" />
            {t("settings.style.presets.custom.edit")}
          </span>
        ),
      },
    ],
    [t, samples, style],
  );

  return (
    <div className="space-y-6">
      {/* Which apps this tab governs. The left rail already names the
          category, so this is a plain header line rather than a second
          coloured banner competing with the one above the panel. */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium">
            {t(`settings.style.appliesIn.${category}`)}
          </h3>
          <p className="text-[12.5px] text-text-muted leading-snug mt-0.5">
            {apps.length > 0
              ? t("settings.style.appliesInHint")
              : t("settings.style.appliesIn.otherHint")}
          </p>
        </div>
        {apps.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {apps.map((a) => (
              <img
                key={a.label}
                src={a.icon}
                alt={a.label}
                title={a.label}
                className="w-6 h-6 rounded-[6px]"
              />
            ))}
          </div>
        )}
      </div>

      <section>
        <SectionLabel>{t("settings.style.sections.style")}</SectionLabel>
        <StylePicker
          ariaLabel={t("settings.style.sections.style")}
          options={options}
          value={style.selected_style}
          onSelect={pickStyle}
        />

        {customEditorOpen && (
          <div className="mt-3 rounded-xl border border-hairline-strong bg-fill-1 p-4">
            <div className="text-[13px] font-medium mb-3">
              {t("settings.style.custom.editorTitle")}
            </div>

            <div className="flex flex-col gap-3.5">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-text-muted">
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
                <span className="text-xs font-medium text-text-muted">
                  {t("settings.style.custom.promptLabel")}
                </span>
                <Textarea
                  placeholder={t("settings.style.custom.promptPlaceholder")}
                  value={customDraft.prompt}
                  onChange={(e) =>
                    setCustomDraft((d) => ({ ...d, prompt: e.target.value }))
                  }
                  rows={5}
                  className="w-full"
                />
                <span className="text-xs text-text-muted">
                  {t("settings.style.custom.promptHint")}
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-hairline">
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
      </section>

      <section>
        <SectionLabel hint={t("settings.style.vocab.hint")}>
          {t("settings.style.vocab.title")}
        </SectionLabel>
        <div className="rounded-xl border border-hairline-strong p-3.5 space-y-3">
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
              className="flex-1"
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
                  className="inline-flex items-center gap-1 ps-2 pe-1.5 py-1 rounded-md border border-hairline-strong bg-fill-1 text-xs"
                >
                  <span>{w}</span>
                  <button
                    type="button"
                    onClick={() => removeVocab(w)}
                    className="text-text-faint hover:text-danger transition-colors cursor-pointer"
                    aria-label={t("common.remove")}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
