import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Award,
  BookA,
  Bug,
  Keyboard,
  KeyRound,
  NotebookPen,
  Info,
  Wand2,
  BrainCircuit,
  Layers,
  Mic,
  Terminal,
  Gauge,
  Settings as SettingsIcon,
  ChevronLeft,
  ArrowLeftRight,
} from "lucide-react";
import GhostlyLogo from "./icons/GhostwriterLogo";
import { useSettings } from "../hooks/useSettings";
import { commands, type UsageStats } from "@/bindings";
import {
  AchievementsSettings,
  GeneralSettings,
  AdvancedSettings,
  DictionarySettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
  StyleSettings,
  UsageSettings,
  DeveloperSettings,
  LicenseSettings,
} from "./settings";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    icon: Mic,
    component: GeneralSettings,
    enabled: () => true,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Wand2,
    component: PostProcessingSettings,
    enabled: () => true,
  },
  style: {
    labelKey: "sidebar.style",
    icon: Layers,
    component: StyleSettings,
    enabled: () => true,
  },
  dictionary: {
    labelKey: "sidebar.dictionary",
    icon: BookA,
    component: DictionarySettings,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: NotebookPen,
    component: HistorySettings,
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Keyboard,
    component: AdvancedSettings,
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    icon: BrainCircuit,
    component: ModelsSettings,
    enabled: () => true,
  },
  usage: {
    labelKey: "sidebar.usage",
    icon: Gauge,
    component: UsageSettings,
    enabled: () => true,
  },
  license: {
    labelKey: "sidebar.license",
    icon: KeyRound,
    component: LicenseSettings,
    enabled: () => true,
  },
  developer: {
    labelKey: "sidebar.developer",
    icon: Terminal,
    component: DeveloperSettings,
    enabled: () => true,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: Bug,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
  },
  achievements: {
    labelKey: "sidebar.achievements",
    icon: Award,
    component: AchievementsSettings,
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

const PRIMARY_SECTIONS = [
  "history",
  "style",
  "dictionary",
  "achievements",
  "postprocessing",
  "general",
] as const satisfies readonly SidebarSection[];

interface SettingsGroup {
  labelKey: string;
  items: readonly SidebarSection[];
}

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    labelKey: "sidebar.groups.preferences",
    items: ["advanced", "models", "usage", "license"],
  },
  {
    labelKey: "sidebar.groups.developer",
    items: ["developer", "debug"],
  },
  {
    labelKey: "sidebar.groups.about",
    items: ["about"],
  },
];

const isPrimary = (s: SidebarSection) =>
  (PRIMARY_SECTIONS as readonly SidebarSection[]).includes(s);

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();

  const [view, setView] = useState<"primary" | "settings">(() =>
    isPrimary(activeSection) ? "primary" : "settings",
  );

  // Follow active section if it was changed externally (e.g. deep links).
  useEffect(() => {
    setView(isPrimary(activeSection) ? "primary" : "settings");
  }, [activeSection]);

  const openSettings = () => {
    setView("settings");
    if (isPrimary(activeSection)) {
      onSectionChange("advanced");
    }
  };

  const goBack = () => {
    setView("primary");
    if (!isPrimary(activeSection)) {
      onSectionChange(PRIMARY_SECTIONS[0]);
    }
  };

  return (
    <div className="flex flex-col w-56 h-full border-e border-hairline bg-surface-1/40 backdrop-blur-xl px-2">
      <GhostlyLogo width={140} className="mt-5 mb-3 self-center" />
      <SidebarMetrics />

      {view === "primary" ? (
        <div className="flex flex-col w-full gap-0.5 pt-3 pb-2 border-t border-hairline flex-1 min-h-0">
          {PRIMARY_SECTIONS.map((id) => (
            <NavItem
              key={id}
              id={id}
              active={activeSection === id}
              onClick={() => onSectionChange(id)}
            />
          ))}
          <div className="mt-auto pt-2">
            <button
              type="button"
              onClick={openSettings}
              className="flex gap-2.5 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out text-text-muted hover:text-text hover:bg-white/[0.04]"
            >
              <SettingsIcon
                width={18}
                height={18}
                strokeWidth={1.75}
                className="shrink-0"
              />
              <p className="text-[13px] font-medium truncate">
                {t("sidebar.settings")}
              </p>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col w-full gap-0.5 pt-3 border-t border-hairline">
          <button
            type="button"
            onClick={goBack}
            className="flex gap-2 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out text-text-muted hover:text-text hover:bg-white/[0.04]"
          >
            <ChevronLeft
              width={16}
              height={16}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <p className="text-[13px] font-medium truncate">
              {t("sidebar.back")}
            </p>
          </button>

          {SETTINGS_GROUPS.map((group) => {
            const items = group.items.filter((id) =>
              SECTIONS_CONFIG[id].enabled(settings),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.labelKey} className="mt-4 flex flex-col gap-0.5">
                <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
                  {t(group.labelKey)}
                </p>
                {items.map((id) => (
                  <NavItem
                    key={id}
                    id={id}
                    active={activeSection === id}
                    onClick={() => onSectionChange(id)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

type MetricsRange = "week" | "lifetime";

const SidebarMetrics: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [range, setRange] = useState<MetricsRange>("week");

  const load = async () => {
    const res = await commands.getUsageStats();
    if (res.status === "ok") setStats(res.data);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!stats) return null;

  const isLifetime = range === "lifetime";
  const words = isLifetime ? stats.lifetime_words : stats.words_this_week;
  const seconds = isLifetime ? stats.lifetime_seconds : stats.seconds_used;
  const savedSecs = isLifetime
    ? stats.time_saved_secs_lifetime
    : stats.time_saved_secs_this_week;
  const minutesSaved = Math.floor(savedSecs / 60);
  const wpm = seconds > 0 ? Math.round((words / seconds) * 60) : 0;

  const toggle = () => setRange((r) => (r === "week" ? "lifetime" : "week"));

  return (
    <button
      type="button"
      onClick={toggle}
      title={t(
        isLifetime
          ? "sidebar.metrics.showWeek"
          : "sidebar.metrics.showLifetime",
      )}
      className="mx-1 mb-3 rounded-xl bg-white/[0.025] border border-hairline px-3 py-2.5 text-[11px] leading-tight text-left transition-colors hover:bg-white/[0.04] hover:border-hairline-strong cursor-pointer"
    >
      <div className="flex items-center justify-between mb-2">
        <p className="uppercase tracking-[0.08em] text-[9px] font-semibold text-text-faint">
          {t(
            isLifetime ? "sidebar.metrics.allTime" : "sidebar.metrics.thisWeek",
          )}
        </p>
        <ArrowLeftRight
          width={10}
          height={10}
          className="text-text-faint"
          aria-hidden
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-text-muted">{t("sidebar.metrics.words")}</span>
          <span className="font-mono font-semibold tabular-nums text-text">
            {formatThousands(words)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-text-muted">{t("sidebar.metrics.saved")}</span>
          <span className="font-mono font-semibold tabular-nums text-text">
            {/* eslint-disable-next-line i18next/no-literal-string */}
            {minutesSaved}m
          </span>
        </div>
        {wpm > 0 && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-text-muted">{t("sidebar.metrics.wpm")}</span>
            <span className="font-mono font-semibold tabular-nums text-text">
              {wpm}
            </span>
          </div>
        )}
      </div>
    </button>
  );
};

function formatThousands(n: number): string {
  return n.toLocaleString();
}

interface NavItemProps {
  id: SidebarSection;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ id, active, onClick }) => {
  const { t } = useTranslation();
  const config = SECTIONS_CONFIG[id];
  const Icon = config.icon;
  const label = t(config.labelKey);
  return (
    <div
      className={`group relative flex gap-2.5 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out ${
        active
          ? "bg-white/[0.06] text-text"
          : "text-text-muted hover:text-text hover:bg-white/[0.04]"
      }`}
      onClick={onClick}
    >
      <span
        aria-hidden
        className={`absolute start-0 top-1/2 -translate-y-1/2 w-[2px] rounded-full bg-accent transition-all duration-200 ease-out ${
          active ? "h-5 opacity-100" : "h-0 opacity-0"
        }`}
      />
      <Icon
        width={17}
        height={17}
        strokeWidth={1.75}
        className={`shrink-0 transition-colors ${active ? "text-accent-bright" : ""}`}
      />
      <p className="text-[13px] font-medium truncate" title={label}>
        {label}
      </p>
    </div>
  );
};
