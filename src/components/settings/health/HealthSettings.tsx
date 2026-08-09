import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  requestAccessibilityPermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import {
  AlertTriangle,
  Check,
  FileArchive,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  commands,
  type HealthAction,
  type HealthCheck,
  type HealthReport,
  type HealthStatus,
} from "@/bindings";
import { Button } from "@/components/ui/Button";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { useSettings } from "@/hooks/useSettings";
import { PageHeader } from "../../ui/PageHeader";

/** Jump to another settings screen. Mirrors the app-wide navigation event. */
const navigate = (section: string) => {
  window.dispatchEvent(
    new CustomEvent("ghostly:navigate", { detail: { section } }),
  );
};

const STATUS_STYLES: Record<
  HealthStatus,
  { dot: string; icon: React.ComponentType<{ className?: string }> }
> = {
  Pass: { dot: "text-success bg-success/12", icon: Check },
  Warn: { dot: "text-warning bg-warning/12", icon: AlertTriangle },
  Fail: { dot: "text-danger bg-danger/12", icon: X },
};

/** Summary-banner tint per overall status. Keyed off the same semantic tokens
 *  as the per-check dots so the banner and the rows can never disagree. */
const SUMMARY_STYLES: Record<HealthStatus, { band: string; badge: string }> = {
  Pass: {
    band: "border-success/25 bg-success/[0.06]",
    badge: "bg-success/12 text-success",
  },
  Warn: {
    band: "border-warning/25 bg-warning/[0.06]",
    badge: "bg-warning/12 text-warning",
  },
  Fail: {
    band: "border-danger/25 bg-danger/[0.06]",
    badge: "bg-danger/12 text-danger",
  },
};

export const HealthSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);

  const runChecks = useCallback(async () => {
    setRunning(true);
    try {
      const res = await commands.runHealthCheck();
      if (res.status === "ok") {
        setReport(res.data);
      } else {
        toast.error(t("settings.health.runFailed"));
      }
    } finally {
      setRunning(false);
    }
  }, [t]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const handleAction = async (action: HealthAction) => {
    switch (action) {
      case "OpenMicrophoneSettings":
        await requestMicrophonePermission();
        break;
      case "OpenAccessibilitySettings":
        await requestAccessibilityPermission();
        break;
      case "OpenModels":
        navigate("transcription");
        return;
      case "OpenRefinement":
        navigate("postprocessing");
        return;
      case "OpenAudio":
        navigate("general");
        return;
    }
    // Permission prompts resolve out-of-process; re-check shortly after so the
    // row updates without the user having to hit Re-run.
    window.setTimeout(() => void runChecks(), 1200);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await commands.exportDiagnosticsBundle();
      if (res.status === "ok") {
        toast.success(t("settings.health.exportDone"), {
          action: {
            label: t("settings.health.reveal"),
            onClick: () => void commands.revealDiagnosticsBundle(res.data),
          },
        });
      } else {
        toast.error(res.error);
      }
    } finally {
      setExporting(false);
    }
  };

  const overall = report?.overall ?? "Pass";

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5">
      <PageHeader
        title={t("settings.health.title")}
        description={t("settings.health.subtitle")}
      />

      {/* --- Summary banner ------------------------------------------------ */}
      <div
        className={`rounded-2xl px-4 py-3.5 flex items-center gap-3.5 border transition-colors duration-300 ${SUMMARY_STYLES[overall].band}`}
      >
        <span
          className={`flex items-center justify-center w-9 h-9 rounded-full shrink-0 ${SUMMARY_STYLES[overall].badge}`}
        >
          {overall === "Pass" ? (
            <ShieldCheck className="w-4.5 h-4.5" strokeWidth={1.9} />
          ) : (
            <AlertTriangle className="w-4.5 h-4.5" strokeWidth={1.9} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">
            {t(`settings.health.summary.${overall}`)}
          </p>
          <p className="text-[12px] text-text-muted leading-snug">
            {t(`settings.health.summaryDetail.${overall}`)}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runChecks()}
          disabled={running}
          className="shrink-0 gap-1.5"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${running ? "animate-spin" : ""}`}
          />
          {t("settings.health.recheck")}
        </Button>
      </div>

      {/* --- Individual checks --------------------------------------------- */}
      <SettingsGroup title={t("settings.health.checksTitle")}>
        {report ? (
          report.checks.map((check) => (
            <CheckRow key={check.id} check={check} onAction={handleAction} />
          ))
        ) : (
          // Skeleton rows keep the panel from collapsing while checks run.
          <div className="px-4 py-3 space-y-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-5 rounded-md shimmer-skeleton"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </div>
        )}
      </SettingsGroup>

      {/* --- Support -------------------------------------------------------- */}
      <SettingsGroup
        title={t("settings.health.supportTitle")}
        description={t("settings.health.supportDescription")}
      >
        <SettingContainer
          grouped
          layout="horizontal"
          descriptionMode="inline"
          title={t("settings.health.bundleTitle")}
          description={t("settings.health.bundleDescription")}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting}
            className="gap-1.5 shrink-0"
          >
            <FileArchive className="w-3.5 h-3.5" />
            {exporting
              ? t("settings.health.exporting")
              : t("settings.health.export")}
          </Button>
        </SettingContainer>

        <ToggleSwitch
          grouped
          descriptionMode="inline"
          checked={settings?.error_reporting_enabled ?? false}
          onChange={(checked) =>
            void updateSetting("error_reporting_enabled", checked)
          }
          label={t("settings.health.errorReportingTitle")}
          description={t("settings.health.errorReportingDescription")}
        />
      </SettingsGroup>

      {/* The specific promise, stated where the toggle is — not buried in a
          privacy policy the user would have to go find. */}
      <p className="text-[11.5px] text-text-faint leading-relaxed px-1">
        {t("settings.health.privacyNote")}
      </p>
    </div>
  );
};

interface CheckRowProps {
  check: HealthCheck;
  onAction: (action: HealthAction) => void;
}

const CheckRow: React.FC<CheckRowProps> = ({ check, onAction }) => {
  const { t } = useTranslation();
  const style = STATUS_STYLES[check.status];
  const Icon = style.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span
        className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${style.dot}`}
      >
        <Icon className="w-3 h-3" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-tight">
          {t(`settings.health.checks.${check.id}.label`, {
            defaultValue: check.id,
          })}
        </p>
        <p className="text-[11.5px] text-text-muted leading-snug mt-0.5">
          {t(`settings.health.checks.${check.id}.${check.status}`, {
            defaultValue: check.detail ?? "",
            detail: check.detail ?? "",
          })}
        </p>
      </div>

      {check.action && (
        <Button
          variant="primary-soft"
          size="sm"
          onClick={() => onAction(check.action as HealthAction)}
          className="shrink-0"
        >
          {t(`settings.health.actions.${check.action}`)}
        </Button>
      )}
    </div>
  );
};
