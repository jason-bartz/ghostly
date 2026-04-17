import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookA, Send } from "lucide-react";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { AutoSubmit } from "../AutoSubmit";
import { RestApiSettings } from "../RestApiSettings";

export const DeveloperSettings: React.FC = () => {
  const { t } = useTranslation();

  const openDictionary = () => {
    window.dispatchEvent(
      new CustomEvent("ghostly:navigate", {
        detail: { section: "dictionary" },
      }),
    );
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="text-sm text-mid-gray/70 leading-relaxed">
        {t("settings.developer.intro")}
      </div>

      <SettingsGroup
        title={t("settings.developer.autoSubmit.sectionTitle")}
        description={t("settings.developer.autoSubmit.sectionDescription")}
      >
        <div className="px-4 pt-3 pb-1 flex items-start gap-3 text-xs text-text/70">
          <Send className="w-4 h-4 shrink-0 mt-0.5 text-logo-primary" />
          <span>{t("settings.developer.autoSubmit.worksEverywhere")}</span>
        </div>
        <AutoSubmit descriptionMode="tooltip" grouped />
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.developer.smartVocab.sectionTitle")}
        description={t("settings.developer.smartVocab.sectionDescription")}
      >
        <div className="px-4 py-3 flex items-start gap-3">
          <BookA className="w-5 h-5 shrink-0 mt-0.5 text-logo-primary" />
          <div className="flex-1 min-w-0 space-y-2">
            <p className="text-sm text-text/85 leading-relaxed">
              {t("settings.developer.smartVocab.body")}
            </p>
            <ul className="text-xs text-text/70 space-y-1 list-disc pl-5">
              <li>{t("settings.developer.smartVocab.exampleCoding")}</li>
              <li>{t("settings.developer.smartVocab.exampleWork")}</li>
              <li>{t("settings.developer.smartVocab.exampleEmail")}</li>
            </ul>
            <div className="pt-1">
              <Button variant="secondary" size="sm" onClick={openDictionary}>
                <span className="inline-flex items-center gap-1.5">
                  <span>
                    {t("settings.developer.smartVocab.manageDictionary")}
                  </span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </span>
              </Button>
            </div>
          </div>
        </div>
      </SettingsGroup>

      <RestApiSettings />
    </div>
  );
};
