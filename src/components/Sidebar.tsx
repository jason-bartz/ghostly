import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
  Sparkles,
  Terminal,
  Gauge,
  Stethoscope,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronDown,
  ArrowLeftRight,
  Users,
} from "lucide-react";
import GhostlyLogo from "./icons/GhostwriterLogo";
import { useSettings } from "../hooks/useSettings";
import { commands, type UsageStats } from "@/bindings";
import {
  currentMilestone,
  milestoneProgress,
  nextMilestone,
} from "@/lib/constants/milestones";
import {
  GeneralSettings,
  AdvancedSettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  HealthSettings,
  DeveloperSettings,
  AppSettings,
  AccountSettings,
  TranscriptionSettings,
  RefinementSettings,
  PerformanceSettings,
  MeetingsSection,
} from "./settings";
import { AskSection } from "./ask/AskSection";

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

/**
 * The settings tree, in the order the product actually works:
 * speak → transcribe → refine → insert, then the app itself, then help.
 *
 * The previous tree had two junk drawers. "Recording" held shortcuts, the
 * microphone *and* the colour theme; "Output" held text insertion, model
 * tuning, launch behaviour and GPU acceleration — four unrelated domains under
 * a name describing one of them. Nothing about either name predicted its
 * contents, so finding a setting meant opening both and scanning.
 *
 * Every destination below is named for what it contains.
 */
export const SECTIONS_CONFIG = {
  history: {
    labelKey: "sidebar.history",
    icon: NotebookPen,
    component: HistorySettings,
    enabled: () => true,
  },
  general: {
    labelKey: "sidebar.general",
    icon: Mic,
    component: GeneralSettings,
    enabled: () => true,
  },
  transcription: {
    labelKey: "sidebar.transcription",
    icon: BrainCircuit,
    component: TranscriptionSettings,
    enabled: () => true,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Wand2,
    component: RefinementSettings,
    enabled: () => true,
  },
  meeting: {
    labelKey: "sidebar.meeting",
    icon: Users,
    component: MeetingsSection,
    enabled: () => true,
  },
  ask: {
    labelKey: "sidebar.ask",
    icon: Sparkles,
    component: AskSection,
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Keyboard,
    component: AdvancedSettings,
    enabled: () => true,
  },
  app: {
    labelKey: "sidebar.app",
    icon: SettingsIcon,
    component: AppSettings,
    enabled: () => true,
  },
  account: {
    labelKey: "sidebar.account",
    icon: KeyRound,
    component: AccountSettings,
    enabled: () => true,
  },
  health: {
    labelKey: "sidebar.health",
    icon: Stethoscope,
    component: HealthSettings,
    enabled: () => true,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
  },
  performance: {
    labelKey: "sidebar.performance",
    icon: Gauge,
    component: PerformanceSettings,
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
} as const satisfies Record<string, SectionConfig>;

/**
 * The three surfaces someone actually uses day to day: what they dictated,
 * how dictation behaves, and how it gets cleaned up.
 *
 * Everything else is configuration and lives behind the gear. The previous
 * six-item primary nav put Style, Dictionary, and Achievements at the same
 * level as Notes, which made a settings app out of a dictation app.
 */
const PRIMARY_SECTIONS = [
  "history",
  "meeting",
  "ask",
  "general",
  "postprocessing",
] as const satisfies readonly SidebarSection[];

interface SettingsGroup {
  labelKey: string;
  items: readonly SidebarSection[];
  /** Groups behind the "Advanced" disclosure at the bottom of the settings
   *  list — power-user surfaces that most users should never need to see. */
  advanced?: boolean;
}

const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    labelKey: "sidebar.groups.dictation",
    items: ["transcription", "advanced"],
  },
  {
    labelKey: "sidebar.groups.app",
    items: ["app", "account"],
  },
  {
    labelKey: "sidebar.groups.help",
    items: ["health", "about"],
  },
  {
    labelKey: "sidebar.groups.developer",
    items: ["performance", "developer", "debug"],
    advanced: true,
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
  const stats = useUsageStats();

  const [view, setView] = useState<"primary" | "settings">(() =>
    isPrimary(activeSection) ? "primary" : "settings",
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Follow active section if it was changed externally (e.g. deep links).
  useEffect(() => {
    setView(isPrimary(activeSection) ? "primary" : "settings");
  }, [activeSection]);

  // Never hide the section the user is currently looking at: navigating to
  // Debug via Cmd+Shift+D must not leave the nav with no highlighted item.
  useEffect(() => {
    const inAdvanced = SETTINGS_GROUPS.some(
      (g) =>
        g.advanced && (g.items as readonly string[]).includes(activeSection),
    );
    if (inAdvanced) setShowAdvanced(true);
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
    <div className="relative flex flex-col w-56 h-full px-2 bg-fill-1 backdrop-blur-[28px] backdrop-saturate-150 border-e border-hairline">
      {/* Specular edge. A 1px border alone reads as a divider; a bright inner
          line plus a soft outer falloff reads as the edge of a pane of glass. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 end-0 w-px bg-gradient-to-b from-transparent via-[color:var(--glass-specular)] to-transparent opacity-60"
      />
      <GhostlyLogo width={140} className="mt-5 mb-3 self-center shrink-0" />
      {/* Week's stats belong to the day-to-day surfaces. In the settings view
          the nav is long enough to squeeze the card flat, and a half-height
          stat block reads as a rendering bug — so it steps aside entirely. */}
      {view === "primary" && stats && (
        <>
          <SidebarMetrics stats={stats} />
          <SidebarMilestone lifetimeWords={stats.lifetime_words} />
        </>
      )}

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
              className="flex gap-2.5 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out text-text-muted hover:text-text hover:bg-fill-2"
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
        /* Scrolls in its own right: the sidebar sits inside an overflow-hidden
           column, so without this the groups revealed by the Advanced
           disclosure render below the window and simply never appear. */
        <div className="flex flex-col w-full gap-0.5 pt-3 pb-3 border-t border-hairline flex-1 min-h-0 overflow-y-auto">
          <button
            type="button"
            onClick={goBack}
            className="flex gap-2 shrink-0 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-150 ease-out text-text-muted hover:text-text hover:bg-fill-2"
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

          {SETTINGS_GROUPS.filter((g) => !g.advanced).map((group) => {
            const items = group.items.filter((id) =>
              SECTIONS_CONFIG[id].enabled(settings),
            );
            if (items.length === 0) return null;
            return (
              <div
                key={group.labelKey}
                className="mt-4 flex flex-col gap-0.5 shrink-0"
              >
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

          <AdvancedDisclosure
            expanded={showAdvanced}
            onToggle={() => setShowAdvanced((v) => !v)}
            activeSection={activeSection}
            onSectionChange={onSectionChange}
            settings={settings}
          />
        </div>
      )}
    </div>
  );
};

interface AdvancedDisclosureProps {
  expanded: boolean;
  onToggle: () => void;
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  settings: unknown;
}

/**
 * Collapsed-by-default home for developer and debug surfaces.
 *
 * These exist for a small number of users and are a support liability for
 * everyone else — a confused user who turns a knob in Debug generates a
 * bug report about a setting they didn't know they changed.
 */
const AdvancedDisclosure: React.FC<AdvancedDisclosureProps> = ({
  expanded,
  onToggle,
  activeSection,
  onSectionChange,
  settings,
}) => {
  const { t } = useTranslation();

  const groups = SETTINGS_GROUPS.filter((g) => g.advanced)
    .map((group) => ({
      ...group,
      items: group.items.filter((id) => SECTIONS_CONFIG[id].enabled(settings)),
    }))
    .filter((group) => group.items.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="mt-4 shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex gap-1.5 items-center px-2.5 py-1.5 w-full rounded-lg cursor-pointer transition-colors duration-150 text-text-faint hover:text-text-muted"
      >
        <ChevronDown
          width={12}
          height={12}
          strokeWidth={2}
          className={`shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-180" : "-rotate-90"
          }`}
        />
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em]">
          {t("sidebar.groups.advanced")}
        </p>
      </button>

      {expanded &&
        groups.map((group) => (
          <div key={group.labelKey} className="flex flex-col gap-0.5">
            {group.items.map((id) => (
              <NavItem
                key={id}
                id={id}
                active={activeSection === id}
                onClick={() => onSectionChange(id)}
              />
            ))}
          </div>
        ))}
    </div>
  );
};

type MetricsRange = "week" | "lifetime";

/**
 * Polls the usage snapshot that backs both sidebar cards.
 *
 * Shared rather than called twice so the metrics card and the milestone card
 * can never disagree — two independent 30s timers would drift, and a card
 * reading "48,196 words" above one reading "next: The Great Gatsby (48,196)"
 * looks broken.
 */
function useUsageStats(): UsageStats | null {
  const [stats, setStats] = useState<UsageStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await commands.getUsageStats();
      if (!cancelled && res.status === "ok") setStats(res.data);
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return stats;
}

interface SidebarMetricsProps {
  stats: UsageStats;
}

const SidebarMetrics: React.FC<SidebarMetricsProps> = ({ stats }) => {
  const { t } = useTranslation();
  const [range, setRange] = useState<MetricsRange>("week");

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
      className="glass glimmer shrink-0 mx-1 mb-3 rounded-xl px-3 py-2.5 text-[11px] leading-tight text-left transition-colors hover:border-hairline-strong cursor-pointer"
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

interface SidebarMilestoneProps {
  lifetimeWords: number;
}

/**
 * "You've dictated the length of ___", with a bar filling toward the next
 * comparison.
 *
 * Its own card rather than a row inside the metrics card above, because that
 * card toggles between this week and all time while a milestone is always a
 * lifetime figure — a row that stayed put while the numbers above it flipped
 * would read as a bug.
 *
 * Renders nothing until the first milestone (107 words, one or two
 * dictations). An empty card promising a reward the user hasn't earned is
 * worse than no card, and the gap is measured in minutes.
 */
const SidebarMilestone: React.FC<SidebarMilestoneProps> = ({
  lifetimeWords,
}) => {
  const { t } = useTranslation();

  const reached = currentMilestone(lifetimeWords);
  if (!reached) return null;

  const next = nextMilestone(lifetimeWords);
  const fraction = milestoneProgress(lifetimeWords);
  const percent = Math.round(fraction * 100);

  return (
    <div
      className="glass shrink-0 mx-1 mb-3 rounded-xl px-3 py-2.5 text-[11px] leading-tight"
      title={
        next
          ? t("sidebar.milestone.progress", { percent, title: next.title })
          : undefined
      }
    >
      <p className="uppercase tracking-[0.08em] text-[9px] font-semibold text-text-faint mb-1.5">
        {t("sidebar.milestone.label")}
      </p>
      <p className="font-medium text-text truncate" title={reached.title}>
        {reached.title}
      </p>
      {/* Always rendered, even for the ~19 author-less entries (the King James
          Bible, the Encyclopædia Britannica, "an average TED talk"). The row
          keeps its height either way so the card doesn't change size — it sits
          directly above the nav, and a card that shrank on crossing into an
          author-less milestone would jog every nav item up 14px. */}
      <p className="text-[10px] text-text-muted truncate mt-0.5 min-h-[13px]">
        {reached.author}
      </p>
      {/* Hidden from the accessibility tree: the title attribute above already
          announces the same "N% to X", and a bare progressbar node with no
          label would just add noise to a screen reader. */}
      <div
        aria-hidden
        className="mt-2 h-1 w-full rounded-full bg-fill-2 overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </div>
    </div>
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
      className={`group relative flex gap-2.5 items-center px-2.5 py-2 w-full rounded-lg cursor-pointer transition-all duration-200 ease-out ${
        active
          ? "glass text-text"
          : "text-text-muted hover:text-text hover:bg-fill-2 border border-transparent"
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
