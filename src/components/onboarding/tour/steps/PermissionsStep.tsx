import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Keyboard, Loader2, Mic } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { openPrivacySettings, type PrivacyPane } from "@/lib/systemSettings";
import { StepHeader, SuccessCheck } from "../parts";
import { usePermissions, type PermissionStatus } from "../usePermissions";
import type { TourStepProps } from "../types";

interface CardProps {
  status: PermissionStatus;
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  reassurance: string;
  grantLabel: string;
  waitingLabel: string;
  grantedLabel: string;
  onGrant: () => void;
  /** Privacy pane to fall back to once macOS has stopped prompting. */
  pane: PrivacyPane;
  settingsLabel: string;
  index: number;
}

const PermissionCard: React.FC<CardProps> = ({
  status,
  Icon,
  title,
  body,
  reassurance,
  grantLabel,
  waitingLabel,
  grantedLabel,
  onGrant,
  pane,
  settingsLabel,
  index,
}) => {
  const granted = status === "granted";
  return (
    <div
      data-rise
      style={{ "--i": index } as React.CSSProperties}
      className={`w-full px-4 py-3.5 rounded-xl border transition-colors duration-300 ${
        granted
          ? "bg-success/[0.06] border-success/25"
          : "surface-card border-hairline"
      }`}
    >
      <div className="flex items-start gap-3.5">
        <span
          className={`flex items-center justify-center w-9 h-9 rounded-xl shrink-0 border transition-colors duration-300 ${
            granted
              ? "bg-success/10 border-success/25"
              : "bg-accent/10 border-accent/20"
          }`}
        >
          <Icon
            className={`w-4 h-4 ${granted ? "text-success" : "text-accent-bright"}`}
          />
        </span>

        <div className="flex-1 min-w-0">
          <h3 className="text-[13.5px] font-medium text-text">{title}</h3>
          <p className="text-[12.5px] text-text-muted leading-snug mt-0.5">
            {body}
          </p>
          <p className="text-[11.5px] text-text-faint leading-snug mt-1">
            {reassurance}
          </p>
          {/* macOS prompts once and never again. Someone who has already said
              no — or who dismissed the dialog and is now watching a spinner
              that will never resolve — has System Settings as their only
              remaining route, so the card offers it rather than stranding
              them. */}
          {!granted && (
            <button
              type="button"
              onClick={() => void openPrivacySettings(pane)}
              className="text-[11.5px] text-accent-bright hover:underline mt-1.5 cursor-pointer"
            >
              {settingsLabel}
            </button>
          )}
        </div>

        <div className="shrink-0 self-center">
          {granted ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-success">
              <Check className="w-3.5 h-3.5" />
              {grantedLabel}
            </span>
          ) : status === "waiting" ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {waitingLabel}
            </span>
          ) : (
            <Button variant="primary-soft" size="sm" onClick={onGrant}>
              {grantLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The two macOS permissions, asked for one at a time and explained in terms of
 * what the user gets — not in terms of what the OS calls them. "Accessibility"
 * is Apple's word for an API; to the user it means "type for me".
 *
 * The step resolves itself: granting in System Settings advances the tour
 * without the user having to come back and press anything.
 */
export const PermissionsStep: React.FC<TourStepProps> = ({
  mode,
  onNext,
  setFooter,
}) => {
  const { t } = useTranslation();
  const { state, allGranted, resolving, request } = usePermissions();
  const [celebrating, setCelebrating] = useState(false);
  const blockedOnEntryRef = useRef<boolean | null>(null);
  const advancedRef = useRef(false);

  // Was anything actually outstanding when we arrived? If not, this is a
  // replay and the step should sit still rather than flashing past.
  useEffect(() => {
    if (resolving || blockedOnEntryRef.current !== null) return;
    blockedOnEntryRef.current = !allGranted;
  }, [resolving, allGranted]);

  useEffect(() => {
    setFooter({
      primaryDisabled: !allGranted,
      hint: allGranted ? undefined : t("tour.permissions.hint"),
    });
  }, [allGranted, setFooter, t]);

  // Auto-advance once the last permission lands — but only if the user
  // actually granted something here.
  useEffect(() => {
    if (!allGranted || advancedRef.current) return;
    const earned = blockedOnEntryRef.current === true;
    if (!earned && mode !== "permissions") return;
    advancedRef.current = true;
    setCelebrating(true);
    const timer = window.setTimeout(onNext, 1150);
    return () => window.clearTimeout(timer);
  }, [allGranted, mode, onNext]);

  if (resolving) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-accent-bright" />
      </div>
    );
  }

  if (celebrating) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <SuccessCheck size={64} />
        <p className="text-[17px] font-display tracking-tight text-text">
          {t("tour.permissions.allSet")}
        </p>
        <p className="text-[12.5px] text-text-muted">
          {t("tour.permissions.allSetBody")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pt-1">
      <StepHeader
        eyebrow={t("tour.permissions.eyebrow")}
        title={t("tour.permissions.title")}
        body={t("tour.permissions.body")}
      />

      <div className="flex flex-col gap-2.5">
        <PermissionCard
          index={1}
          status={state.microphone}
          Icon={Mic}
          title={t("tour.permissions.microphone.title")}
          body={t("tour.permissions.microphone.body")}
          reassurance={t("tour.permissions.microphone.reassurance")}
          grantLabel={t("tour.permissions.grant")}
          waitingLabel={t("tour.permissions.waiting")}
          grantedLabel={t("tour.permissions.granted")}
          onGrant={() => void request("microphone")}
          pane="microphone"
          settingsLabel={t("tour.permissions.openSettings")}
        />
        <PermissionCard
          index={2}
          status={state.accessibility}
          Icon={Keyboard}
          title={t("tour.permissions.accessibility.title")}
          body={t("tour.permissions.accessibility.body")}
          reassurance={t("tour.permissions.accessibility.reassurance")}
          grantLabel={t("tour.permissions.grant")}
          waitingLabel={t("tour.permissions.waiting")}
          grantedLabel={t("tour.permissions.granted")}
          onGrant={() => void request("accessibility")}
          pane="accessibility"
          settingsLabel={t("tour.permissions.openSettings")}
        />
      </div>

      <p
        data-rise
        style={{ "--i": 3 } as React.CSSProperties}
        className="text-[11.5px] text-text-faint leading-relaxed text-center px-6"
      >
        {t("tour.permissions.footnote")}
      </p>
    </div>
  );
};

export default PermissionsStep;
