import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Wand2, Layers } from "lucide-react";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { PostProcessingSettings } from "../post-processing/PostProcessingSettings";
import { StyleSettings } from "../profiles/StyleSettings";
import { PageHeader } from "../../ui/PageHeader";

type View = "ai" | "style";

/**
 * Everything that happens to the words after they are transcribed: which model
 * cleans them up, and how they should read once it has.
 *
 * These were two destinations that nobody could tell apart from their names —
 * "AI Refinement" and "Style" are the same job described twice. One pane, one
 * switch: the provider on one side, the voice it writes in on the other.
 */
export const RefinementSettings: React.FC = () => {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("ai");

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <PageHeader
        title={t("settings.pages.refinement.title")}
        description={t("settings.pages.refinement.subtitle")}
      />
      <div className="flex justify-center">
        <SegmentedControl<View>
          value={view}
          onChange={setView}
          ariaLabel={t("settings.refinement.switcher")}
          options={[
            {
              value: "ai",
              label: t("settings.refinement.views.ai"),
              Icon: Wand2,
            },
            {
              value: "style",
              label: t("settings.refinement.views.style"),
              Icon: Layers,
            },
          ]}
        />
      </div>

      {view === "ai" ? <PostProcessingSettings /> : <StyleSettings />}
    </div>
  );
};
