import React from "react";
import { useTranslation } from "react-i18next";
import { WordDictionary } from "../history/WordDictionary";

export const DictionarySettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="space-y-2">
        <div className="px-4">
          <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
            {t("settings.history.dictionary.sectionTitle", "Auto-Corrections")}
          </h2>
        </div>
        <div className="px-4 py-4 bg-background border border-mid-gray/20 rounded-lg">
          <WordDictionary />
        </div>
      </div>
    </div>
  );
};
