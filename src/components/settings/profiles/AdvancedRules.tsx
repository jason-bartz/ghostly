// Power-user escape hatch: per-app custom rules (bundle id / process name /
// window title matching) that override the category-based Style selection.
// Reuses the existing ProfileEditor/ProfileRow — we're just presenting it
// inside a disclosure on the Style page instead of as a top-level feature.

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { commands } from "@/bindings";
import { useSettings } from "../../../hooks/useSettings";
import { Button } from "../../ui/Button";
import { ProfileEditor } from "./ProfileEditor";
import type { MatchRuleLike, ProfileLike } from "./types";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const matchSummary = (rules: MatchRuleLike[]): string => {
  if (rules.length === 0) return "—";
  const first = rules[0].value;
  return rules.length === 1 ? first : `${first} +${rules.length - 1}`;
};

export const AdvancedRules: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, refreshSettings } = useSettings();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const profiles = (getSetting("profiles") as ProfileLike[] | undefined) ?? [];

  useEffect(() => {
    if (profiles.length > 0) setExpanded(true);
  }, [profiles.length]);

  const handleDetect = async (): Promise<Partial<ProfileLike> | null> => {
    const res = await commands.detectFrontmostApp();
    if (res.status !== "ok" || !res.data) {
      toast.error(t("settings.style.advanced.detectFailed"));
      return null;
    }
    const ctx = res.data;
    const rules: MatchRuleLike[] = [];
    if (ctx.bundleId) rules.push({ kind: "bundle_id", value: ctx.bundleId });
    else if (ctx.processName)
      rules.push({ kind: "process_name", value: ctx.processName });
    return {
      name:
        ctx.bundleId || ctx.processName || t("settings.style.advanced.newRule"),
      match_rules: rules,
    };
  };

  const handleAdd = async () => {
    const draft = await handleDetect();
    const profile: ProfileLike = {
      id: newId(),
      name: draft?.name || t("settings.style.advanced.newRule"),
      enabled: true,
      match_rules: draft?.match_rules ?? [],
      prompt_id: null,
      post_process_override: null,
      custom_vocab: [],
      append_trailing_space: null,
      provider_override: null,
      keystroke_commands: [],
      auto_submit: null,
      image_paste_uses_shift: false,
    };
    const res = await commands.addProfile(profile);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    setEditingId(profile.id);
    setExpanded(true);
  };

  const handleSave = async (p: ProfileLike) => {
    const res = await commands.updateProfile(p);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    const res = await commands.deleteProfile(id);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    if (editingId === id) setEditingId(null);
  };

  return (
    <div className="rounded-xl border border-mid-gray/20 bg-mid-gray/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left cursor-pointer hover:bg-mid-gray/5"
      >
        <div>
          <div className="text-sm font-semibold">
            {t("settings.style.advanced.title")}
          </div>
          <div className="text-xs text-text/60 mt-0.5">
            {t("settings.style.advanced.description")}
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-text/60 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="border-t border-mid-gray/15">
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="text-xs text-text/60">
              {profiles.length === 0
                ? t("settings.style.advanced.empty")
                : t("settings.style.advanced.count", {
                    count: profiles.length,
                  })}
            </div>
            <Button variant="primary" size="sm" onClick={handleAdd}>
              <span className="inline-flex items-center gap-1">
                <Plus className="w-4 h-4" />
                <span>{t("settings.style.advanced.add")}</span>
              </span>
            </Button>
          </div>

          {profiles.map((p) => (
            <div key={p.id} className="px-4 py-3 border-t border-mid-gray/10">
              {editingId === p.id ? (
                <ProfileEditor
                  profile={p}
                  onSave={handleSave}
                  onCancel={() => setEditingId(null)}
                  onDetect={handleDetect}
                />
              ) : (
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) =>
                      handleSave({ ...p, enabled: e.target.checked })
                    }
                    className="accent-logo-primary w-4 h-4 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{p.name}</div>
                    <div
                      className="text-xs text-text/60 truncate font-mono"
                      title={p.match_rules.map((r) => r.value).join(", ")}
                    >
                      {matchSummary(p.match_rules)}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditingId(p.id)}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    onClick={() => handleDelete(p.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
