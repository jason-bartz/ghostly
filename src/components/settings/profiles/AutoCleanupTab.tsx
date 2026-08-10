import React from "react";
import { useTranslation } from "react-i18next";
import { StylePicker, type StyleOption } from "./StylePicker";
import { SectionLabel } from "./SectionLabel";
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
  /** Ordinal weight, drawn as the little meter on the row. */
  intensity: number;
  isDefault?: boolean;
}> = [
  {
    id: "none",
    titleKey: "settings.style.cleanup.none.title",
    subKey: "settings.style.cleanup.none.subtitle",
    sampleKey: "settings.style.cleanup.none.sample",
    intensity: 0,
  },
  {
    id: "light",
    titleKey: "settings.style.cleanup.light.title",
    subKey: "settings.style.cleanup.light.subtitle",
    sampleKey: "settings.style.cleanup.light.sample",
    intensity: 1,
  },
  {
    id: "medium",
    titleKey: "settings.style.cleanup.medium.title",
    subKey: "settings.style.cleanup.medium.subtitle",
    sampleKey: "settings.style.cleanup.medium.sample",
    intensity: 2,
    isDefault: true,
  },
  {
    id: "high",
    titleKey: "settings.style.cleanup.high.title",
    subKey: "settings.style.cleanup.high.subtitle",
    sampleKey: "settings.style.cleanup.high.sample",
    intensity: 3,
  },
];

export const AutoCleanupTab: React.FC<AutoCleanupTabProps> = ({
  level,
  onLevelChanged,
}) => {
  const { t } = useTranslation();

  const options: StyleOption[] = LEVELS.map((lvl) => ({
    id: lvl.id,
    title: t(lvl.titleKey),
    subtitle: t(lvl.subKey),
    sample: t(lvl.sampleKey),
    intensity: lvl.intensity,
    badge: lvl.isDefault ? (
      <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-text-faint">
        {t("settings.style.cleanup.defaultBadge")}
      </span>
    ) : undefined,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">
          {t("settings.style.cleanup.headerTitle")}
        </h3>
        <p className="text-[12.5px] text-text-muted leading-snug mt-0.5">
          {t("settings.style.cleanup.headerSubtitle")}
        </p>
      </div>

      <section>
        <SectionLabel>{t("settings.style.cleanup.sectionLabel")}</SectionLabel>
        <StylePicker
          ariaLabel={t("settings.style.cleanup.sectionLabel")}
          options={options}
          value={level}
          onSelect={(id) => onLevelChanged(id as AutoCleanupLevel)}
        />
      </section>
    </div>
  );
};
