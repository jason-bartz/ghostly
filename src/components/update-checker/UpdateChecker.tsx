import React from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

const RELEASES_URL = "https://github.com/jason-bartz/ghostly/releases";

interface UpdateCheckerProps {
  className?: string;
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ className = "" }) => {
  const { t } = useTranslation();

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <button
        onClick={() => openUrl(RELEASES_URL)}
        className="transition-colors text-text/60 hover:text-text/80 tabular-nums"
      >
        {t("footer.downloadLatest")}
      </button>
    </div>
  );
};

export default UpdateChecker;
