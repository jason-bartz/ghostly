import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Command } from "lucide-react";
import { commands } from "@/bindings";
import { useSettings } from "../../../hooks/useSettings";
import { SettingsGroup, ToggleSwitch } from "../../ui";
import { Button } from "../../ui/Button";
import { ProfileEditor } from "./ProfileEditor";
import type { ProfileLike, MatchRuleLike } from "./types";
import { getAppInfoByProfileId } from "@/lib/appIcons";

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const matchSummary = (rules: MatchRuleLike[]): string => {
  if (rules.length === 0) return "—";
  const first = rules[0].value;
  return rules.length === 1 ? first : `${first} +${rules.length - 1}`;
};

export const ProfilesSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();

  const enabled = getSetting("profiles_enabled") ?? false;
  const builtinEnabled = getSetting("builtin_profiles_enabled") ?? true;
  const profiles = (getSetting("profiles") as ProfileLike[] | undefined) ?? [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [builtins, setBuiltins] = useState<ProfileLike[]>([]);

  useEffect(() => {
    let cancelled = false;
    commands.getBuiltinProfiles().then((res) => {
      if (cancelled) return;
      if (res.status === "ok") setBuiltins(res.data as ProfileLike[]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      name:
        ctx.bundleId || ctx.processName || t("settings.profiles.newProfile"),
      match_rules: rules,
    };
  };

  const handleAdd = async () => {
    const draft = await handleDetect();
    const profile: ProfileLike = {
      id: newId(),
      name: draft?.name || t("settings.profiles.newProfile"),
      enabled: true,
      match_rules: draft?.match_rules ?? [],
      prompt_id: null,
      post_process_override: null,
      custom_vocab: [],
      append_trailing_space: null,
      provider_override: null,
      image_paste_uses_shift: false,
    };
    const res = await commands.addProfile(profile);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    setEditingId(profile.id);
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

  const handleCustomize = async (b: ProfileLike) => {
    const profile: ProfileLike = {
      ...b,
      id: newId(),
      name: b.name,
      // Strip the "builtin_" prompt id so users see "Inherit" by default —
      // they can re-pick a prompt explicitly in the editor.
      prompt_id: null,
      custom_vocab: [...b.custom_vocab],
      match_rules: b.match_rules.map((r) => ({ ...r })),
    };
    const res = await commands.addProfile(profile);
    if (res.status === "error") {
      toast.error(res.error);
      return;
    }
    await refreshSettings();
    setEditingId(profile.id);
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <p className="text-[13px] leading-relaxed text-text-muted">
        {t("settings.profiles.intro")}
      </p>
      <SettingsGroup title={t("settings.profiles.title")}>
        <ToggleSwitch
          label={t("settings.profiles.enable.title")}
          description={t("settings.profiles.enable.description")}
          checked={enabled}
          onChange={(v) => updateSetting("profiles_enabled", v)}
          isUpdating={isUpdating("profiles_enabled")}
          descriptionMode="inline"
          grouped={true}
        />
      </SettingsGroup>

      {enabled && (
        <SettingsGroup title={t("settings.profiles.builtin.sectionTitle")}>
          <ToggleSwitch
            label={t("settings.profiles.builtin.title")}
            description={t("settings.profiles.builtin.description")}
            checked={builtinEnabled}
            onChange={async (v) => {
              await commands.setBuiltinProfilesEnabled(v);
              await refreshSettings();
            }}
            descriptionMode="inline"
            grouped={true}
          />
          {builtinEnabled && builtins.length > 0 && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-text/70">
                <Command className="w-3 h-3" />
                <span>{t("settings.profiles.builtin.idesHeader")}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {builtins.map((b) => (
                  <BuiltinChip
                    key={b.id}
                    profile={b}
                    onCustomize={() => handleCustomize(b)}
                  />
                ))}
              </div>
            </div>
          )}
        </SettingsGroup>
      )}

      {enabled && (
        <SettingsGroup title={t("settings.profiles.custom.sectionTitle")}>
          <div className="px-4 py-3 flex items-center justify-between">
            <div className="text-sm text-text/70">
              {profiles.length === 0
                ? t("settings.profiles.custom.empty")
                : t("settings.profiles.count", { count: profiles.length })}
            </div>
            <Button variant="primary" size="sm" onClick={handleAdd}>
              <span className="inline-flex items-center gap-1">
                <Plus className="w-4 h-4" />
                <span>{t("settings.profiles.add")}</span>
              </span>
            </Button>
          </div>

          {profiles.length === 0 ? (
            <div className="px-4 pb-4 text-xs text-text/60">
              {t("settings.profiles.custom.emptyHint")}
            </div>
          ) : (
            profiles.map((p) => (
              <div key={p.id} className="px-4 py-3">
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
            ))
          )}
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
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <input
        type="checkbox"
        checked={profile.enabled}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        className="accent-logo-primary w-4 h-4 shrink-0"
        aria-label={t("settings.profiles.fields.enabled")}
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{profile.name}</div>
        <div
          className="text-xs text-text/60 truncate font-mono"
          title={profile.match_rules.map((r) => r.value).join(", ")}
        >
          {matchSummary(profile.match_rules)}
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onEdit}
        aria-label={t("settings.profiles.editAria")}
      >
        <Pencil className="w-4 h-4" />
      </Button>
      <Button
        variant="danger-ghost"
        size="sm"
        onClick={onDelete}
        aria-label={t("settings.profiles.delete")}
      >
        <Trash2 className="w-4 h-4" />
      </Button>
    </div>
  );
};

interface BuiltinChipProps {
  profile: ProfileLike;
  onCustomize: () => void;
}

const BuiltinChip: React.FC<BuiltinChipProps> = ({ profile, onCustomize }) => {
  const { t } = useTranslation();
  const appInfo = getAppInfoByProfileId(profile.id);
  return (
    <div
      className="group flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border border-hairline bg-white/[0.025] hover:border-accent/40 hover:bg-white/[0.05] transition-colors"
      title={profile.match_rules.map((r) => r.value).join("\n")}
    >
      <span className="flex items-center gap-2 text-sm font-medium truncate">
        {appInfo && (
          <img
            src={appInfo.icon}
            alt=""
            className="w-5 h-5 rounded-[4px] shrink-0"
          />
        )}
        {profile.name}
      </span>
      <button
        onClick={onCustomize}
        className="opacity-0 group-hover:opacity-100 text-[10px] font-medium text-accent-bright hover:underline focus:opacity-100 focus:outline-none whitespace-nowrap"
      >
        {t("settings.profiles.builtin.customize")}
      </button>
    </div>
  );
};
