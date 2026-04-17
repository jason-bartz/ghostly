import React from "react";
import { useTranslation } from "react-i18next";
import { StyleCard } from "./StyleCard";
import type { AutoCleanupLevel } from "./types";

interface AutoCleanupTabProps {
  level: AutoCleanupLevel;
  onLevelChanged: (next: AutoCleanupLevel) => void | Promise<void>;
}

const LEVELS: Array<{
  id: AutoCleanupLevel;
  titleKey: string;
  subKey: string;
  sampleKey: string;
}> = [
  {
    id: "none",
    titleKey: "settings.style.cleanup.none.title",
    subKey: "settings.style.cleanup.none.subtitle",
    sampleKey: "settings.style.cleanup.none.sample",
  },
  {
    id: "light",
    titleKey: "settings.style.cleanup.light.title",
    subKey: "settings.style.cleanup.light.subtitle",
    sampleKey: "settings.style.cleanup.light.sample",
  },
  {
    id: "medium",
    titleKey: "settings.style.cleanup.medium.title",
    subKey: "settings.style.cleanup.medium.subtitle",
    sampleKey: "settings.style.cleanup.medium.sample",
  },
  {
    id: "high",
    titleKey: "settings.style.cleanup.high.title",
    subKey: "settings.style.cleanup.high.subtitle",
    sampleKey: "settings.style.cleanup.high.sample",
  },
];

export const AutoCleanupTab: React.FC<AutoCleanupTabProps> = ({
  level,
  onLevelChanged,
}) => {
  const { t } = useTranslation();

  const pick = (next: AutoCleanupLevel) => {
    onLevelChanged(next);
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl bg-gradient-to-r from-sky-500/15 via-sky-500/5 to-transparent border border-sky-500/20 px-4 py-3">
        <div className="text-sm font-medium">
          {t("settings.style.cleanup.headerTitle")}
        </div>
        <div className="text-xs text-text/60 mt-0.5">
          {t("settings.style.cleanup.headerSubtitle")}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {LEVELS.map((lvl) => (
          <StyleCard
            key={lvl.id}
            title={t(lvl.titleKey)}
            subtitle={t(lvl.subKey)}
            sample={t(lvl.sampleKey)}
            selected={level === lvl.id}
            onSelect={() => pick(lvl.id)}
          />
        ))}
      </div>
    </div>
  );
};
