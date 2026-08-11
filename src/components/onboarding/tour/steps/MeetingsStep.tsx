import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Mic, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { commands } from "@/bindings";
import type { MeetingSettings, SystemAudioCapability } from "@/bindings";
import { openPrivacySettings } from "@/lib/systemSettings";
import { StepHeader } from "../parts";
import { usePermissions } from "../usePermissions";
import type { TourStepProps } from "../types";

interface LaneRowProps {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  enabled: boolean;
  /** Rendered in place of the control when the lane can't run on this Mac. */
  unavailable?: string | null;
  busy?: boolean;
  enabledLabel: string;
  enableLabel: string;
  disableLabel: string;
  onEnable: () => void;
  /** Absent when the lane can only be turned on (a granted OS permission). */
  onDisable?: () => void;
  index: number;
}

/**
 * One capture lane, stated as what it does for the user rather than as the
 * mechanism behind it. "System audio via a CoreAudio process tap" is the truth
 * and is useless; "transcribe other people's voices" is the same truth in the
 * only terms that matter when deciding whether to allow it.
 */
const LaneRow: React.FC<LaneRowProps> = ({
  Icon,
  title,
  body,
  enabled,
  unavailable,
  busy,
  enabledLabel,
  enableLabel,
  disableLabel,
  onEnable,
  onDisable,
  index,
}) => (
  <div
    data-rise
    style={{ "--i": index } as React.CSSProperties}
    className="flex items-start gap-3.5 px-4 py-3.5"
  >
    <span
      className={`flex items-center justify-center w-9 h-9 rounded-xl shrink-0 border transition-colors duration-300 ${
        enabled
          ? "bg-success/10 border-success/25"
          : "bg-accent/10 border-accent/20"
      }`}
    >
      <Icon
        className={`w-4 h-4 ${enabled ? "text-success" : "text-accent-bright"}`}
      />
    </span>

    <div className="flex-1 min-w-0">
      <h3 className="text-[13.5px] font-medium text-text">{title}</h3>
      <p className="text-[12.5px] text-text-muted leading-snug mt-0.5">
        {unavailable ?? body}
      </p>
    </div>

    <div className="shrink-0 self-center">
      {unavailable ? null : busy ? (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        </span>
      ) : enabled ? (
        // Enabled is a state, not a button — but it stays clickable when the
        // lane is ours to turn off, so this screen is a control panel rather
        // than a wall of fait accompli.
        onDisable ? (
          <button
            type="button"
            onClick={onDisable}
            title={disableLabel}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-success bg-success/[0.08] hover:bg-success/15 transition-colors cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            {enabledLabel}
          </button>
        ) : (
          // Same pill as the clickable variant. The two rows sit on top of each
          // other, and a difference in shape between them would read as a
          // difference in meaning.
          <span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-success bg-success/[0.08]">
            <Check className="w-3.5 h-3.5" />
            {enabledLabel}
          </span>
        )
      ) : (
        <Button variant="primary-soft" size="sm" onClick={onEnable}>
          {enableLabel}
        </Button>
      )}
    </div>
  </div>
);

/**
 * Meeting Mode, introduced as the two things it can hear.
 *
 * Both lanes ship on, so this is a consent screen rather than a setup screen:
 * the user is being told what Ghostly will listen to before it ever does, and
 * given the switch. That ordering is the whole point — a capture feature the
 * user discovers *after* it has run is a betrayal, however good the transcript.
 *
 * The far-side lane needs no macOS permission at all (a CoreAudio process tap,
 * not screen recording), which is worth saying out loud: it is the difference
 * between Ghostly and a meeting bot, and users have been trained by every other
 * tool to expect the worse answer.
 */
export const MeetingsStep: React.FC<TourStepProps> = ({ setFooter }) => {
  const { t } = useTranslation();
  const { state, request } = usePermissions();
  const [settings, setSettings] = useState<MeetingSettings | null>(null);
  const [capability, setCapability] = useState<SystemAudioCapability | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  // Mirrors `settings` for `patch`, which must not read a value React has not
  // re-rendered with yet — two quick toggles would otherwise compose against a
  // stale object and silently drop the first.
  const settingsRef = useRef<MeetingSettings | null>(null);

  const apply = useCallback((value: MeetingSettings) => {
    settingsRef.current = value;
    setSettings(value);
  }, []);

  useEffect(() => {
    let active = true;
    void commands.getMeetingSettings().then((value) => {
      if (active) apply(value);
    });
    void commands.getSystemAudioCapability().then((value) => {
      if (active) setCapability(value);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  useEffect(() => {
    setFooter({ hint: t("tour.meetings.hint") });
  }, [setFooter, t]);

  const patch = useCallback(
    async (changes: Partial<MeetingSettings>) => {
      const current = settingsRef.current;
      if (!current) return;
      const next = { ...current, ...changes };
      apply(next);
      setSaving(true);
      const result = await commands.updateMeetingSettings(next);
      setSaving(false);
      if (result.status === "error") {
        console.error("Failed to save meeting settings:", result.error);
        apply(await commands.getMeetingSettings());
      }
    },
    [apply],
  );

  const micGranted = state.microphone === "granted";
  const micWaiting = state.microphone === "waiting";
  const supported = capability?.supported ?? true;
  // A lane the master switch has turned off is off, whatever its own flag says.
  const othersOn = !!settings?.enabled && !!settings.captureSystemAudio;

  return (
    <div className="flex flex-col gap-5 pt-1">
      <StepHeader
        eyebrow={t("tour.meetings.eyebrow")}
        title={t("tour.meetings.title")}
        body={t("tour.meetings.body")}
      />

      <div
        data-rise
        style={{ "--i": 1 } as React.CSSProperties}
        className="surface-card border border-hairline rounded-xl divide-y divide-hairline overflow-hidden"
      >
        <LaneRow
          index={2}
          Icon={Mic}
          title={t("tour.meetings.myVoice.title")}
          body={t("tour.meetings.myVoice.body")}
          enabled={micGranted}
          busy={micWaiting}
          enabledLabel={t("tour.meetings.enabled")}
          enableLabel={t("tour.meetings.enable")}
          disableLabel={t("tour.meetings.turnOff")}
          onEnable={() => void request("microphone")}
        />
        <LaneRow
          index={3}
          Icon={Users}
          title={t("tour.meetings.theirVoices.title")}
          body={t("tour.meetings.theirVoices.body")}
          enabled={othersOn}
          busy={saving}
          unavailable={
            supported ? null : (capability?.unavailableReason ?? null)
          }
          enabledLabel={t("tour.meetings.enabled")}
          enableLabel={t("tour.meetings.enable")}
          disableLabel={t("tour.meetings.turnOff")}
          // Turning this on has to lift the master switch too, or the row would
          // report enabled while Meeting Mode stayed inert.
          onEnable={() =>
            void patch({ enabled: true, captureSystemAudio: true })
          }
          onDisable={() => void patch({ captureSystemAudio: false })}
        />
      </div>

      {/* The one thing macOS will not let the app fix for itself. */}
      {!micGranted && !micWaiting && (
        <p
          data-rise
          style={{ "--i": 4 } as React.CSSProperties}
          className="text-[11.5px] text-text-faint leading-relaxed text-center"
        >
          {t("tour.meetings.micDenied")}{" "}
          <button
            type="button"
            onClick={() => void openPrivacySettings("microphone")}
            className="text-accent-bright hover:underline cursor-pointer"
          >
            {t("tour.meetings.openSettings")}
          </button>
        </p>
      )}

      <p
        data-rise
        style={{ "--i": 5 } as React.CSSProperties}
        className="text-[11.5px] text-text-faint leading-relaxed text-center px-6"
      >
        {t("tour.meetings.footnote")}
      </p>
    </div>
  );
};

export default MeetingsStep;
