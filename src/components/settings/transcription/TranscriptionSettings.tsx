import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, BookA } from "lucide-react";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ModelsSettings } from "../models/ModelsSettings";
import { DictionarySettings } from "../dictionary/DictionarySettings";
import { FillerWords } from "../FillerWords";
import { ModelUnloadTimeoutSetting } from "../ModelUnloadTimeout";
import { PageHeader } from "../../ui/PageHeader";

type View = "model" | "words";

/**
 * Everything that turns speech into words: which model runs, and which words
 * it should be told about.
 *
 * Model and Dictionary were separate destinations, and the two settings that
 * tune transcription — filler-word removal and model unloading — were stranded
 * in a pane called "Output". They belong to the same question, so they share a
 * pane. The two halves are big enough to warrant a switch rather than one very
 * long scroll; the control sits at the top of the pane, so it is a visible
 * choice rather than a hidden second level of navigation.
 */
export const TranscriptionSettings: React.FC = () => {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("model");

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <PageHeader
        title={t("settings.pages.transcription.title")}
        description={t("settings.pages.transcription.subtitle")}
      />
      <div className="flex justify-center">
        <SegmentedControl<View>
          value={view}
          onChange={setView}
          ariaLabel={t("settings.transcription.switcher")}
          options={[
            {
              value: "model",
              label: t("settings.transcription.views.model"),
              Icon: BrainCircuit,
            },
            {
              value: "words",
              label: t("settings.transcription.views.words"),
              Icon: BookA,
            },
          ]}
        />
      </div>

      {view === "model" ? (
        <>
          <ModelsSettings />
          <SettingsGroup title={t("settings.advanced.groups.transcription")}>
            <FillerWords descriptionMode="tooltip" grouped />
            <ModelUnloadTimeoutSetting descriptionMode="tooltip" grouped />
          </SettingsGroup>
        </>
      ) : (
        <DictionarySettings />
      )}
    </div>
  );
};
