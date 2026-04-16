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
import type {
  AutoCleanupLevel,
  CategoryId,
  CategoryStyleLike,
} from "./types";

type TabKey = CategoryId | "cleanup" | "advanced";

const TABS: Array<{
  key: TabKey;
  labelKey: string;
  Icon: React.ComponentType<{ className?: string }>;
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
  },
  {
    key: "advanced",
    labelKey: "settings.style.tabs.advanced",
    Icon: Settings2,
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
    <div className="max-w-4xl w-full mx-auto space-y-6">
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
        <div className="rounded-2xl border border-mid-gray/20 bg-background overflow-hidden">
          {/* Top tab strip */}
          <div className="flex items-center gap-1 px-2 pt-2 border-b border-mid-gray/15 overflow-x-auto">
            {TABS.map(({ key, labelKey, Icon }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className={`relative flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap
                    ${
                      active
                        ? "text-text"
                        : "text-text/60 hover:text-text"
                    }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{t(labelKey)}</span>
                  {active && (
                    <span className="absolute left-2 right-2 -bottom-[1px] h-0.5 bg-logo-primary rounded-full" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="p-5">
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
