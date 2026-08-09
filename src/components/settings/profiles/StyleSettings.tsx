import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  MessageCircle,
  Briefcase,
  Mail,
  Code,
  Globe,
  Sparkles,
  Settings2,
} from "lucide-react";
import { useSettings } from "../../../hooks/useSettings";
import { SettingsGroup, ToggleSwitch } from "../../ui";
import { styleCommands } from "@/lib/styleBindings";
import { CategoryTab } from "./CategoryTab";
import { AutoCleanupTab } from "./AutoCleanupTab";
import { AdvancedRules } from "./AdvancedRules";
import type { AutoCleanupLevel, CategoryId, CategoryStyleLike } from "./types";

type TabKey = CategoryId | "cleanup" | "advanced";

const TABS: Array<{
  key: TabKey;
  labelKey: string;
  Icon: React.ComponentType<{ className?: string }>;
  aside?: boolean;
}> = [
  {
    key: "personal_messages",
    labelKey: "settings.style.tabs.personal",
    Icon: MessageCircle,
  },
  {
    key: "work_messages",
    labelKey: "settings.style.tabs.work",
    Icon: Briefcase,
  },
  { key: "email", labelKey: "settings.style.tabs.email", Icon: Mail },
  { key: "coding", labelKey: "settings.style.tabs.coding", Icon: Code },
  { key: "other", labelKey: "settings.style.tabs.other", Icon: Globe },
  {
    key: "cleanup",
    labelKey: "settings.style.tabs.cleanup",
    Icon: Sparkles,
    // Rule-shaped rather than category-shaped: these two configure the system
    // itself, so the rail sets them below a divider instead of implying they
    // are a sixth and seventh kind of writing.
    aside: true,
  },
  {
    key: "advanced",
    labelKey: "settings.style.tabs.advanced",
    Icon: Settings2,
    aside: true,
  },
];

export const StyleSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, refreshSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<TabKey>("personal_messages");
  const [categoryStyles, setCategoryStyles] = useState<CategoryStyleLike[]>([]);
  const [cleanup, setCleanup] = useState<AutoCleanupLevel>(
    (getSetting("auto_cleanup_level") as AutoCleanupLevel | undefined) ??
      "light",
  );

  const enabled = (getSetting("style_enabled") as boolean | undefined) ?? true;

  useEffect(() => {
    styleCommands
      .getCategoryStyles()
      .then(setCategoryStyles)
      .catch((e) => toast.error(String(e)));
  }, []);

  useEffect(() => {
    const next = getSetting("auto_cleanup_level") as
      | AutoCleanupLevel
      | undefined;
    if (next) setCleanup(next);
  }, [getSetting]);

  const styleByCategory = useMemo(() => {
    const map: Partial<Record<CategoryId, CategoryStyleLike>> = {};
    for (const cs of categoryStyles) map[cs.category_id] = cs;
    return map;
  }, [categoryStyles]);

  const toggleEnabled = async (v: boolean) => {
    try {
      await styleCommands.setStyleEnabled(v);
      await refreshSettings();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <div className="w-full space-y-6">
      <SettingsGroup title={t("settings.style.title")}>
        <ToggleSwitch
          label={t("settings.style.enable.title")}
          description={t("settings.style.enable.description")}
          checked={enabled}
          onChange={toggleEnabled}
          descriptionMode="inline"
          grouped
        />
      </SettingsGroup>

      {enabled && (
        <div className="rounded-2xl border border-hairline-strong bg-background overflow-hidden flex">
          {/* Left rail. Seven tabs across the top overflowed horizontally with
              no visible scrollbar, so "Vibe Coding" and everything after it
              were effectively invisible. Vertically they all fit, and the list
              stays legible if more categories are added. */}
          <div
            role="tablist"
            aria-label={t("settings.style.title")}
            className="shrink-0 w-[168px] border-e border-hairline-strong p-2 flex flex-col gap-0.5"
          >
            {TABS.map(({ key, labelKey, Icon, aside }, i) => {
              const active = activeTab === key;
              const startsAside = aside && !TABS[i - 1]?.aside;
              return (
                <React.Fragment key={key}>
                  {startsAside && (
                    <span
                      aria-hidden
                      className="my-1.5 mx-2 border-t border-hairline"
                    />
                  )}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTab(key)}
                    className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium text-start transition-all duration-200 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                      active
                        ? "glass text-text"
                        : "text-text-muted hover:text-text hover:bg-fill-2 border border-transparent"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`absolute start-0 top-1/2 -translate-y-1/2 w-[2px] rounded-full bg-accent transition-all duration-200 ease-out ${
                        active ? "h-5 opacity-100" : "h-0 opacity-0"
                      }`}
                    />
                    <Icon
                      className={`w-4 h-4 shrink-0 transition-colors ${active ? "text-accent-bright" : ""}`}
                    />
                    <span className="truncate">{t(labelKey)}</span>
                  </button>
                </React.Fragment>
              );
            })}
          </div>

          <div className="flex-1 min-w-0 p-5">
            {activeTab === "cleanup" ? (
              <AutoCleanupTab
                level={cleanup}
                onLevelChanged={async (next) => {
                  setCleanup(next);
                  try {
                    await styleCommands.setAutoCleanupLevel(next);
                    await refreshSettings();
                  } catch (e) {
                    toast.error(String(e));
                  }
                }}
              />
            ) : activeTab === "advanced" ? (
              <AdvancedRules />
            ) : (
              <RenderCategoryTab
                category={activeTab}
                style={styleByCategory[activeTab]}
                onChanged={setCategoryStyles}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const LoadingLabel: React.FC = () => {
  const { t } = useTranslation();
  return <span>{t("common.loading")}</span>;
};

interface RenderCategoryTabProps {
  category: CategoryId;
  style: CategoryStyleLike | undefined;
  onChanged: (next: CategoryStyleLike[]) => void;
}

const RenderCategoryTab: React.FC<RenderCategoryTabProps> = ({
  category,
  style,
  onChanged,
}) => {
  // Guard: while the initial `getCategoryStyles()` is in flight the style
  // for this tab may be undefined. Render a skeleton instead of the tab
  // body so the page doesn't flicker between categories.
  if (!style) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-text/50">
        <LoadingLabel />
      </div>
    );
  }
  // Unmount when `category` changes so internal state (editor open, vocab
  // draft) resets. Avoids the "stale state on tab switch" bug.
  return (
    <CategoryTab
      key={category}
      category={category}
      style={style}
      onChanged={onChanged}
    />
  );
};
