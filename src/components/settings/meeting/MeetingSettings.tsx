import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { Slider } from "../../ui/Slider";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Dropdown } from "../../ui/Dropdown";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { commands } from "../../../bindings";
import type {
  MeetingSettings as MeetingSettingsType,
  SystemAudioCapability,
} from "../../../bindings";

/**
 * Meeting Mode settings.
 *
 * Meeting settings live in a nested `meeting` object rather than as flat
 * `AppSettings` fields, so this pane talks to dedicated get/update commands
 * instead of the generic `useSettings` hook.
 */
export const MeetingSettings: React.FC = () => {
  const { t } = useTranslation();

  const [settings, setSettings] = useState<MeetingSettingsType | null>(null);
  const [capability, setCapability] = useState<SystemAudioCapability | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  // Unparsed exclusion text while the field has focus. `null` means "show the
  // saved value".
  const [exclusionsDraft, setExclusionsDraft] = useState<string | null>(null);
  // Free-text fields are edited locally and committed explicitly.
  //
  // Saving per keystroke sent the entire settings blob on every character, and
  // those writes race: an earlier, shorter value can land after a later one, so
  // the field appeared to "only save one character". A draft plus an explicit
  // Save is both correct and predictable.
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void commands.getMeetingSettings().then((value) => {
      if (active) setSettings(value);
    });
    void commands.getSystemAudioCapability().then((value) => {
      if (active) setCapability(value);
    });
    return () => {
      active = false;
    };
  }, []);

  // Builds the next value from the *latest* state rather than from a snapshot
  // captured when the callback was created. The pane loads once and the backend
  // also writes to these settings ("Never auto-connect for this app" from the
  // detection prompt), so sending a stale whole-object copy would silently
  // revert those changes.
  // Writes are serialised. Each save sends the whole settings object, so two
  // in-flight requests can complete out of order and an older value can land
  // last — which is what made a dragged slider or a fast-typed field snap back.
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  const patch = useCallback(async (changes: Partial<MeetingSettingsType>) => {
    let next: MeetingSettingsType | null = null;
    setSettings((current) => {
      if (!current) return current;
      next = { ...current, ...changes };
      return next;
    });
    const pending = next;
    if (!pending) return;

    setSaving(true);
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(async () => {
        const result = await commands.updateMeetingSettings(pending);
        if (result.status === "error") {
          console.error("Failed to save meeting settings:", result.error);
          // Re-read rather than restoring a snapshot, which would also undo an
          // edit that succeeded while this one was in flight.
          setSettings(await commands.getMeetingSettings());
        }
      })
      .finally(() => setSaving(false));

    await saveChain.current;
  }, []);

  if (!settings) {
    return (
      <div className="p-4 text-[13px] text-text-subtle">
        {t("meeting.settings.loading")}
      </div>
    );
  }

  const systemAudioUnavailable = capability && !capability.supported;

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("meeting.settings.groupCapture")}>
        <ToggleSwitch
          checked={settings.enabled}
          onChange={(value) => void patch({ enabled: value })}
          isUpdating={saving}
          label={t("meeting.settings.enableLabel")}
          description={t("meeting.settings.enableDescription")}
          descriptionMode="tooltip"
          grouped
        />

        {settings.enabled && (
          <>
            <Alert variant="info" contained>
              {t("meeting.settings.consentNotice")}
            </Alert>

            {systemAudioUnavailable && (
              <Alert variant="warning" contained>
                {capability?.unavailableReason}
              </Alert>
            )}

            <ToggleSwitch
              checked={settings.captureSystemAudio}
              onChange={(value) => void patch({ captureSystemAudio: value })}
              label={t("meeting.settings.systemAudioLabel")}
              description={t("meeting.settings.systemAudioDescription")}
              descriptionMode="tooltip"
              grouped
              disabled={!!systemAudioUnavailable}
            />

            <ToggleSwitch
              checked={settings.showLivePanel}
              onChange={(value) => void patch({ showLivePanel: value })}
              label={t("meeting.settings.livePanelLabel")}
              description={t("meeting.settings.livePanelDescription")}
              descriptionMode="tooltip"
              grouped
            />
          </>
        )}
      </SettingsGroup>

      {settings.enabled && (
        <>
          <SettingsGroup title={t("meeting.settings.groupAutoConnect")}>
            <SettingContainer
              title={t("meeting.settings.autoConnectLabel")}
              description={t("meeting.settings.autoConnectDescription")}
              descriptionMode="tooltip"
              grouped
            >
              <Dropdown
                options={[
                  { value: "off", label: t("meeting.settings.autoConnectOff") },
                  { value: "ask", label: t("meeting.settings.autoConnectAsk") },
                  {
                    value: "auto",
                    label: t("meeting.settings.autoConnectAuto"),
                  },
                ]}
                selectedValue={settings.autoConnect}
                onSelect={(value) =>
                  void patch({
                    autoConnect: value as MeetingSettingsType["autoConnect"],
                  })
                }
              />
            </SettingContainer>

            {settings.autoConnect === "auto" && (
              <Slider
                value={settings.autoConnectCountdownSecs}
                onChange={(value) =>
                  void patch({ autoConnectCountdownSecs: Math.round(value) })
                }
                min={3}
                max={15}
                step={1}
                label={t("meeting.settings.countdownLabel")}
                description={t("meeting.settings.countdownDescription")}
                descriptionMode="tooltip"
                grouped
                formatValue={(value) => `${Math.round(value)}s`}
              />
            )}

            <Slider
              value={settings.autoStopGraceSecs}
              onChange={(value) =>
                void patch({ autoStopGraceSecs: Math.round(value) })
              }
              min={10}
              max={120}
              step={5}
              label={t("meeting.settings.autoStopLabel")}
              description={t("meeting.settings.autoStopDescription")}
              descriptionMode="tooltip"
              grouped
              formatValue={(value) => `${Math.round(value)}s`}
            />

            <SettingContainer
              title={t("meeting.settings.exclusionsLabel")}
              description={t("meeting.settings.exclusionsDescription")}
              descriptionMode="tooltip"
              grouped
              layout="stacked"
            >
              {/* Raw text is held locally and only parsed on blur. Splitting
                  and re-joining on every keystroke deletes the separator the
                  moment it is typed, making a second pattern impossible. */}
              <Input
                value={
                  exclusionsDraft ?? settings.excludedTitlePatterns.join(", ")
                }
                onChange={(event) => setExclusionsDraft(event.target.value)}
                onBlur={() => {
                  if (exclusionsDraft === null) return;
                  const parsed = exclusionsDraft
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean);
                  setExclusionsDraft(null);
                  void patch({ excludedTitlePatterns: parsed });
                }}
                placeholder={t("meeting.settings.exclusionsPlaceholder")}
              />
            </SettingContainer>
          </SettingsGroup>

          <SettingsGroup title={t("meeting.settings.groupSummaries")}>
            <SettingContainer
              title={t("meeting.settings.summaryBackendLabel")}
              description={t("meeting.settings.summaryBackendDescription")}
              descriptionMode="tooltip"
              grouped
            >
              <Dropdown
                options={[
                  {
                    value: "on_device",
                    label: t("meeting.settings.summaryOnDevice"),
                  },
                  {
                    value: "cloud",
                    label: t("meeting.settings.summaryCloud"),
                  },
                  {
                    value: "extractive",
                    label: t("meeting.settings.summaryExtractive"),
                  },
                ]}
                selectedValue={settings.summaryBackend}
                onSelect={(value) =>
                  void patch({
                    summaryBackend:
                      value as MeetingSettingsType["summaryBackend"],
                  })
                }
              />
            </SettingContainer>

            {settings.summaryBackend === "cloud" && (
              <Alert variant="warning" contained>
                {t("meeting.settings.cloudWarning")}
              </Alert>
            )}
          </SettingsGroup>

          <SettingsGroup title={t("meeting.settings.groupAlerts")}>
            <SettingContainer
              title={t("meeting.settings.yourNameLabel")}
              description={t("meeting.settings.yourNameDescription")}
              descriptionMode="tooltip"
              grouped
            >
              <div className="flex items-center gap-2">
                <Input
                  value={nameDraft ?? settings.userDisplayName}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && nameDraft !== null) {
                      void patch({ userDisplayName: nameDraft.trim() });
                      setNameDraft(null);
                    }
                    if (event.key === "Escape") setNameDraft(null);
                  }}
                  placeholder={t("meeting.settings.yourNamePlaceholder")}
                />
                <Button
                  variant="secondary"
                  disabled={
                    nameDraft === null ||
                    nameDraft.trim() === settings.userDisplayName
                  }
                  onClick={() => {
                    if (nameDraft === null) return;
                    void patch({ userDisplayName: nameDraft.trim() });
                    setNameDraft(null);
                  }}
                >
                  {t("meeting.settings.save")}
                </Button>
              </div>
            </SettingContainer>

            <ToggleSwitch
              checked={settings.mentionAlerts}
              onChange={(value) => void patch({ mentionAlerts: value })}
              label={t("meeting.settings.mentionAlertsLabel")}
              description={t("meeting.settings.mentionAlertsDescription")}
              descriptionMode="tooltip"
              grouped
              disabled={!settings.userDisplayName.trim()}
            />
          </SettingsGroup>

          <SettingsGroup title={t("meeting.settings.groupPrivacy")}>
            <Slider
              value={settings.retentionDays}
              onChange={(value) =>
                void patch({ retentionDays: Math.round(value) })
              }
              min={0}
              max={365}
              step={1}
              label={t("meeting.settings.retentionLabel")}
              description={t("meeting.settings.retentionDescription")}
              descriptionMode="tooltip"
              grouped
              formatValue={(value) =>
                Math.round(value) === 0
                  ? t("meeting.settings.retentionForever")
                  : t("meeting.settings.retentionDays", {
                      count: Math.round(value),
                    })
              }
            />

            <div className="flex items-center gap-3 px-4 py-3">
              <Button
                variant="secondary"
                onClick={() => void commands.startMeeting(null)}
              >
                {t("meeting.settings.startNow")}
              </Button>
              <span className="text-[13px] text-text-muted">
                {t("meeting.settings.startNowHint")}
              </span>
            </div>
          </SettingsGroup>
        </>
      )}
    </div>
  );
};
