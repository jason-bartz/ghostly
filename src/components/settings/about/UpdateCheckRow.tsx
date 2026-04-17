import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { SettingContainer } from "../../ui/SettingContainer";
import { useUpdaterStore } from "@/stores/updaterStore";

interface UpdateCheckRowProps {
  currentVersion: string;
}

const formatRelative = (ms: number): string => {
  const diff = Date.now() - ms;
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

export const UpdateCheckRow: React.FC<UpdateCheckRowProps> = ({
  currentVersion,
}) => {
  const { t } = useTranslation();
  const status = useUpdaterStore((s) => s.status);
  const available = useUpdaterStore((s) => s.available);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const error = useUpdaterStore((s) => s.error);
  const check = useUpdaterStore((s) => s.check);
  const openModal = useUpdaterStore((s) => s.openModal);

  const isChecking = status === "checking";
  const isUpdateVisible =
    status === "available" ||
    status === "downloading" ||
    status === "ready";

  const statusLine = (() => {
    if (isChecking) return t("updater.settings.checking");
    if (isUpdateVisible && available) {
      return t("updater.settings.available", { version: available.version });
    }
    if (status === "error" && error) {
      return t("updater.settings.checkFailed");
    }
    if (status === "up-to-date") {
      return t("updater.settings.upToDate", { version: currentVersion });
    }
    return t("updater.settings.description");
  })();

  const lastCheckedLine = lastCheckedAt
    ? t("updater.settings.lastCheckedLabel", {
        when: formatRelative(lastCheckedAt),
      })
    : t("updater.settings.lastCheckedNever");

  return (
    <SettingContainer
      title={t("updater.settings.title")}
      description={`${statusLine} ${lastCheckedLine}`}
      descriptionMode="inline"
      grouped={true}
    >
      {isUpdateVisible ? (
        <button
          onClick={openModal}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-accent-deep hover:bg-background-ui-hover text-white transition-colors"
        >
          {t("updater.settings.viewButton")}
        </button>
      ) : (
        <button
          onClick={() => void check({ silent: false })}
          disabled={isChecking}
          className="px-3 py-1.5 text-xs font-medium rounded-full border border-hairline-strong text-text hover:bg-white/[0.04] disabled:opacity-60 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
        >
          {isChecking && <Loader2 className="w-3 h-3 animate-spin" />}
          {isChecking
            ? t("updater.settings.checking")
            : t("updater.settings.checkButton")}
        </button>
      )}
    </SettingContainer>
  );
};
