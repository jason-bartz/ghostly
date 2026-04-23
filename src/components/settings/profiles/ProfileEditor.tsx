import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, Crosshair } from "lucide-react";
import { Dropdown, SettingContainer, ToggleSwitch } from "../../ui";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { useSettings } from "../../../hooks/useSettings";
import type { MatchRuleKind, MatchRuleLike, ProfileLike } from "./types";

interface Props {
  profile: ProfileLike;
  onSave: (p: ProfileLike) => void | Promise<void>;
  onCancel: () => void;
  onDetect: () => Promise<Partial<ProfileLike> | null>;
}

type TriState = "inherit" | "on" | "off";

const boolToTri = (v: boolean | null | undefined): TriState =>
  v === null || v === undefined ? "inherit" : v ? "on" : "off";

const triToBool = (t: TriState): boolean | null =>
  t === "inherit" ? null : t === "on";

const RULE_KINDS: MatchRuleKind[] = [
  "bundle_id",
  "process_name",
  "window_class",
  "exe_path_contains",
  "window_title_contains",
];

export const ProfileEditor: React.FC<Props> = ({
  profile,
  onSave,
  onCancel,
  onDetect,
}) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const [draft, setDraft] = useState<ProfileLike>(profile);
  const [newVocab, setNewVocab] = useState("");

  const prompts =
    (getSetting("post_process_prompts") as
      | Array<{ id: string; name: string }>
      | undefined) ?? [];
  const providers =
    (getSetting("post_process_providers") as
      | Array<{ id: string; label: string }>
      | undefined) ?? [];

  const update = <K extends keyof ProfileLike>(key: K, value: ProfileLike[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const addRule = () =>
    update("match_rules", [
      ...draft.match_rules,
      { kind: "bundle_id", value: "" },
    ]);

  const updateRule = (i: number, patch: Partial<MatchRuleLike>) => {
    const next = draft.match_rules.slice();
    next[i] = { ...next[i], ...patch };
    update("match_rules", next);
  };

  const removeRule = (i: number) => {
    const next = draft.match_rules.slice();
    next.splice(i, 1);
    update("match_rules", next);
  };

  const addVocab = () => {
    const w = newVocab.trim().replace(/[<>"'&]/g, "");
    if (!w || draft.custom_vocab.includes(w)) return;
    update("custom_vocab", [...draft.custom_vocab, w]);
    setNewVocab("");
  };

  const removeVocab = (w: string) =>
    update(
      "custom_vocab",
      draft.custom_vocab.filter((v) => v !== w),
    );

  const handleDetect = async () => {
    const r = await onDetect();
    if (!r) return;
    if (r.match_rules && r.match_rules.length > 0) {
      update("match_rules", [...draft.match_rules, ...r.match_rules]);
    }
    if (r.name && !draft.name) update("name", r.name);
  };

  return (
    <div className="flex flex-col gap-3">
      <SettingContainer
        title={t("settings.profiles.fields.name")}
        description=""
        descriptionMode="inline"
        layout="horizontal"
        grouped={true}
      >
        <Input
          type="text"
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder={t("settings.profiles.fields.namePlaceholder")}
          variant="compact"
          className="min-w-[260px]"
        />
      </SettingContainer>

      {/* Rules */}
      <div className="flex flex-col gap-2 px-4 py-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">
              {t("settings.profiles.fields.rules")}
            </div>
            <div className="text-xs text-text/60">
              {t("settings.profiles.fields.rulesHint")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleDetect}>
              <Crosshair className="w-4 h-4" />
              <span>{t("settings.profiles.detectCurrent")}</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={addRule}>
              <Plus className="w-4 h-4" />
              <span>{t("settings.profiles.fields.addRule")}</span>
            </Button>
          </div>
        </div>
        {draft.match_rules.length === 0 ? (
          <div className="text-sm text-text/60 italic">
            {t("settings.profiles.fields.rulesEmpty")}
          </div>
        ) : (
          draft.match_rules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2">
              <Dropdown
                className="min-w-[160px]"
                options={RULE_KINDS.map((k) => ({
                  value: k,
                  label: t(`settings.profiles.rule.${kindI18n(k)}`),
                }))}
                selectedValue={rule.kind}
                onSelect={(v) => updateRule(i, { kind: v as MatchRuleKind })}
              />
              <Input
                type="text"
                value={rule.value}
                onChange={(e) => updateRule(i, { value: e.target.value })}
                placeholder={placeholderFor(rule.kind, t)}
                variant="compact"
                className="flex-1 min-w-[200px]"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeRule(i)}
                aria-label="remove rule"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Prompt override */}
      <SettingContainer
        title={t("settings.profiles.fields.prompt")}
        description={t("settings.profiles.fields.promptDescription")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <Dropdown
          className="min-w-[260px]"
          options={[
            {
              value: "__inherit__",
              label: t("settings.profiles.fields.promptInherit"),
            },
            ...prompts.map((p) => ({ value: p.id, label: p.name })),
          ]}
          selectedValue={draft.prompt_id ?? "__inherit__"}
          onSelect={(v) => update("prompt_id", v === "__inherit__" ? null : v)}
        />
      </SettingContainer>

      {/* Post-process tri-state */}
      <SettingContainer
        title={t("settings.profiles.fields.postProcess")}
        description=""
        descriptionMode="inline"
        layout="horizontal"
        grouped={true}
      >
        <Dropdown
          className="min-w-[180px]"
          options={[
            {
              value: "inherit",
              label: t("settings.profiles.fields.postProcessInherit"),
            },
            {
              value: "on",
              label: t("settings.profiles.fields.postProcessOn"),
            },
            {
              value: "off",
              label: t("settings.profiles.fields.postProcessOff"),
            },
          ]}
          selectedValue={boolToTri(draft.post_process_override)}
          onSelect={(v) =>
            update("post_process_override", triToBool(v as TriState))
          }
        />
      </SettingContainer>

      {/* Provider override */}
      <SettingContainer
        title={t("settings.profiles.fields.provider")}
        description=""
        descriptionMode="inline"
        layout="horizontal"
        grouped={true}
      >
        <Dropdown
          className="min-w-[260px]"
          options={[
            {
              value: "__inherit__",
              label: t("settings.profiles.fields.providerInherit"),
            },
            ...providers.map((p) => ({ value: p.id, label: p.label })),
          ]}
          selectedValue={draft.provider_override ?? "__inherit__"}
          onSelect={(v) =>
            update("provider_override", v === "__inherit__" ? null : v)
          }
        />
      </SettingContainer>

      {/* Trailing space tri-state */}
      <SettingContainer
        title={t("settings.profiles.fields.trailingSpace")}
        description=""
        descriptionMode="inline"
        layout="horizontal"
        grouped={true}
      >
        <Dropdown
          className="min-w-[180px]"
          options={[
            {
              value: "inherit",
              label: t("settings.profiles.fields.trailingSpaceInherit"),
            },
            {
              value: "on",
              label: t("settings.profiles.fields.trailingSpaceOn"),
            },
            {
              value: "off",
              label: t("settings.profiles.fields.trailingSpaceOff"),
            },
          ]}
          selectedValue={boolToTri(draft.append_trailing_space)}
          onSelect={(v) =>
            update("append_trailing_space", triToBool(v as TriState))
          }
        />
      </SettingContainer>

      {/* Custom vocab */}
      <div className="flex flex-col gap-2 px-4 py-2">
        <div>
          <div className="text-sm font-medium">
            {t("settings.profiles.fields.customVocab")}
          </div>
          <div className="text-xs text-text/60">
            {t("settings.profiles.fields.customVocabHint")}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={newVocab}
            onChange={(e) => setNewVocab(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addVocab();
              }
            }}
            placeholder={t("settings.profiles.fields.customVocabPlaceholder")}
            variant="compact"
            className="max-w-[220px]"
          />
          <Button variant="secondary" size="sm" onClick={addVocab}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>
        {draft.custom_vocab.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.custom_vocab.map((w) => (
              <Button
                key={w}
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1"
                onClick={() => removeVocab(w)}
              >
                <span>{w}</span>
                <X className="w-3 h-3" />
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Image paste uses Shift (for VS Code Copilot Chat and similar) */}
      <ToggleSwitch
        label={t("settings.profiles.fields.imagePasteShift")}
        description={t("settings.profiles.fields.imagePasteShiftHint")}
        checked={draft.image_paste_uses_shift}
        onChange={(v) => update("image_paste_uses_shift", v)}
        descriptionMode="inline"
        grouped={true}
      />

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-mid-gray/20">
        <Button variant="secondary" size="md" onClick={onCancel}>
          {t("settings.profiles.cancel")}
        </Button>
        <Button variant="primary" size="md" onClick={() => onSave(draft)}>
          {t("settings.profiles.save")}
        </Button>
      </div>
    </div>
  );
};

function kindI18n(k: MatchRuleKind): string {
  switch (k) {
    case "bundle_id":
      return "bundleId";
    case "process_name":
      return "processName";
    case "window_class":
      return "windowClass";
    case "exe_path_contains":
      return "exePathContains";
    case "window_title_contains":
      return "windowTitleContains";
  }
}

function placeholderFor(kind: MatchRuleKind, t: (k: string) => string): string {
  switch (kind) {
    case "bundle_id":
      return t("settings.profiles.rule.bundleIdPlaceholder");
    case "process_name":
      return t("settings.profiles.rule.processNamePlaceholder");
    default:
      return "";
  }
}
