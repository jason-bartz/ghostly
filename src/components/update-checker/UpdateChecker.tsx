import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle } from "lucide-react";
import { useUpdaterStore } from "@/stores/updaterStore";

interface UpdateCheckerProps {
  className?: string;
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ className = "" }) => {
  const { t } = useTranslation();
  const status = useUpdaterStore((s) => s.status);
  const progress = useUpdaterStore((s) => s.progress);
  const openModal = useUpdaterStore((s) => s.openModal);
  const restartNow = useUpdaterStore((s) => s.restartNow);

  const Separator = () => (
    <span className="text-text-faint">{"•"}</span>
  );

  if (status === "downloading") {
    const percent = progress?.percent ?? 0;
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <span className="text-text/70 tabular-nums">
          {t("footer.updateDownloading")}{" "}
          {t("updater.modal.progress", { percent: Math.round(percent) })}
        </span>
        <Separator />
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <button
          onClick={restartNow}
          className="flex items-center gap-1.5 text-accent-bright hover:text-accent-glow transition-colors"
        >
          <ArrowUpCircle className="w-3.5 h-3.5" />
          <span>{t("footer.updateReady")}</span>
        </button>
        <Separator />
      </div>
    );
  }

  if (status === "available") {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <button
          onClick={openModal}
          className="flex items-center gap-1.5 text-accent-bright hover:text-accent-glow transition-colors"
        >
          <ArrowUpCircle className="w-3.5 h-3.5" />
          <span>{t("footer.updateAvailable")}</span>
        </button>
        <Separator />
      </div>
    );
  }

  return null;
};

export default UpdateChecker;
