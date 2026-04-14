import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, Pencil } from "lucide-react";
import { commands } from "@/bindings";
import { useSettings } from "../../../hooks/useSettings";
import { SettingsGroup, ToggleSwitch } from "../../ui";
import { Button } from "../../ui/Button";
import { ProfileEditor } from "./ProfileEditor";
import type { ProfileLike, MatchRuleLike } from "./types";

const newId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

export const ProfilesSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();

  const enabled = (getSetting("profiles_enabled" as any) as boolean) ?? false;
  const profiles =
    (getSetting("profiles" as any) as ProfileLike[] | undefined) ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);

  const handleDetect = async (): Promise<Partial<ProfileLike> | null> => {
    const res = await commands.detectFrontmostApp();
    if (res.status !== "ok" || !res.data) {
      toast.error(t("settings.profiles.detectFailed"));
      return null;
    }
    const ctx = res.data;
    const rules: MatchRuleLike[] = [];
    if (ctx.bundleId) {
      rules.push({ kind: "bundle_id", value: ctx.bundleId });
    } else if (ctx.processName) {
      rules.push({ kind: "process_name", value: ctx.processName });
    }
    return {
      name: ctx.bundleId || ctx.processName || "New profile",
      match_rules: rules,
    };
  };

  const handleAdd = async () => {
    const draft = await handleDetect();
    const profile: ProfileLike = {
      id: newId(),
      name: draft?.name || "New profile",
      enabled: true,
      match_rules: draft?.match_rules ?? [],
      prompt_id: null,
      post_process_override: null,
      custom_vocab: [],
      append_trailing_space: null,
      provider_override: null,
    };
    const res = await commands.addProfile(profile as any);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    setEditingId(profile.id);
  };

  const handleSave = async (p: ProfileLike) => {
    const res = await commands.updateProfile(p as any);
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
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.profiles.title")}>
        <ToggleSwitch
          label={t("settings.profiles.enable.title")}
          description={t("settings.profiles.enable.description")}
          checked={enabled}
          onChange={(v) => updateSetting("profiles_enabled" as any, v as any)}
          isUpdating={isUpdating("profiles_enabled")}
          descriptionMode="inline"
          grouped={true}
        />
      </SettingsGroup>

      {enabled && (
        <SettingsGroup>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="text-sm text-text/70">
              {profiles.length === 0
                ? t("settings.profiles.empty")
                : `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`}
            </div>
            <Button variant="primary" size="sm" onClick={handleAdd}>
              <Plus className="w-4 h-4" />
              <span>{t("settings.profiles.add")}</span>
            </Button>
          </div>

          {profiles.map((p) => (
            <div key={p.id} className="px-4 py-3 flex flex-col gap-2">
              {editingId === p.id ? (
                <ProfileEditor
                  profile={p}
                  onSave={handleSave}
                  onCancel={() => setEditingId(null)}
                  onDetect={handleDetect}
                />
              ) : (
                <ProfileRow
                  profile={p}
                  onEdit={() => setEditingId(p.id)}
                  onDelete={() => handleDelete(p.id)}
                  onToggleEnabled={(v) => handleSave({ ...p, enabled: v })}
                />
              )}
            </div>
          ))}
        </SettingsGroup>
      )}
    </div>
  );
};

interface ProfileRowProps {
  profile: ProfileLike;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (v: boolean) => void;
}

const ProfileRow: React.FC<ProfileRowProps> = ({
  profile,
  onEdit,
  onDelete,
  onToggleEnabled,
}) => {
  const summary = profile.match_rules
    .map((r) => `${ruleKindLabel(r.kind)}: ${r.value}`)
    .join(" · ");
  return (
    <div className="flex items-center gap-3">
      <input
        type="checkbox"
        checked={profile.enabled}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        className="accent-logo-primary"
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{profile.name}</div>
        <div className="text-xs text-text/60 truncate">
          {summary || "—"}
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onEdit}>
        <Pencil className="w-4 h-4" />
      </Button>
      <Button variant="secondary" size="sm" onClick={onDelete}>
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
};

function ruleKindLabel(kind: MatchRuleLike["kind"]): string {
  switch (kind) {
    case "bundle_id":
      return "bundle";
    case "process_name":
      return "proc";
    case "window_class":
      return "wm_class";
    case "exe_path_contains":
      return "exe~";
    case "window_title_contains":
      return "title~";
    default:
      return kind;
  }
}
