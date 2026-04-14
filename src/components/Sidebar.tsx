import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Award,
  BookA,
  Bug,
  Keyboard,
  History,
  Info,
  Wand2,
  BrainCircuit,
  Layers,
  Mic,
  Terminal,
  Gauge,
  Settings as SettingsIcon,
  ChevronLeft,
} from "lucide-react";
import GhostlyLogo from "./icons/GhostwriterLogo";
import { useSettings } from "../hooks/useSettings";
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
  ProfilesSettings,
  UsageSettings,
  DeveloperSettings,
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
  profiles: {
    labelKey: "sidebar.profiles",
    icon: Layers,
    component: ProfilesSettings,
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
    icon: History,
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
  "general",
  "postprocessing",
  "profiles",
  "dictionary",
  "history",
] as const satisfies readonly SidebarSection[];

interface SettingsGroup {
  labelKey: string;
  items: readonly SidebarSection[];
}

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    labelKey: "sidebar.groups.preferences",
    items: ["advanced", "models", "usage"],
  },
  {
    labelKey: "sidebar.groups.developer",
    items: ["developer", "debug"],
  },
  {
    labelKey: "sidebar.groups.about",
    items: ["about", "achievements"],
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
      onSectionChange("general");
    }
  };

  return (
    <div className="flex flex-col w-40 h-full border-e border-mid-gray/20 px-2">
      <GhostlyLogo width={130} className="m-4 self-center" />

      {view === "primary" ? (
        <div className="flex flex-col w-full gap-1 pt-2 pb-2 border-t border-mid-gray/20 flex-1 min-h-0">
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
              className="flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out hover:bg-mid-gray/20 hover:translate-x-0.5 opacity-80 hover:opacity-100"
            >
              <SettingsIcon
                width={20}
                height={20}
                strokeWidth={1.75}
                className="shrink-0"
              />
              <p className="text-sm font-medium truncate">
                {t("sidebar.settings")}
              </p>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col w-full gap-1 pt-2 border-t border-mid-gray/20">
          <button
            type="button"
            onClick={goBack}
            className="flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out hover:bg-mid-gray/20 opacity-80 hover:opacity-100"
          >
            <ChevronLeft
              width={18}
              height={18}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <p className="text-sm font-medium truncate">
              {t("sidebar.back")}
            </p>
          </button>

          {SETTINGS_GROUPS.map((group) => {
            const items = group.items.filter((id) =>
              SECTIONS_CONFIG[id].enabled(settings),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.labelKey} className="mt-3 flex flex-col gap-1">
                <p className="px-2 text-[10px] font-semibold uppercase tracking-wider text-text/50">
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
      className={`relative flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out ${
        active
          ? "bg-logo-primary/80 shadow-sm"
          : "hover:bg-mid-gray/20 hover:translate-x-0.5 hover:opacity-100 opacity-80"
      }`}
      onClick={onClick}
    >
      <span
        aria-hidden
        className={`absolute start-0 top-1/2 -translate-y-1/2 w-0.5 rounded-full bg-logo-primary transition-all duration-200 ease-out ${
          active ? "h-5 opacity-100" : "h-0 opacity-0"
        }`}
      />
      <Icon
        width={20}
        height={20}
        strokeWidth={1.75}
        className="shrink-0"
      />
      <p className="text-sm font-medium truncate" title={label}>
        {label}
      </p>
    </div>
  );
};
