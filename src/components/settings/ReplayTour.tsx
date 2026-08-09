import React from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";

/**
 * Replay the guided tour.
 *
 * The tour is where most people first hear about verbatim mode, edit-last,
 * screenshot Q&A and per-app styles — features that are otherwise three clicks
 * deep. Making it repeatable turns a one-shot first-run flow into a permanent
 * reference someone can go back to when they finally have a use for the deep
 * end.
 */
export const ReplayTour: React.FC<{ grouped?: boolean }> = ({
  grouped = false,
}) => {
  const { t } = useTranslation();

  return (
    <SettingContainer
      title={t("settings.tour.title")}
      description={t("settings.tour.description")}
      descriptionMode="inline"
      grouped={grouped}
    >
      <Button
        variant="secondary"
        size="md"
        onClick={() =>
          window.dispatchEvent(new CustomEvent("ghostly:replay-tour"))
        }
        className="gap-1.5"
      >
        <Compass className="w-3.5 h-3.5" />
        {t("settings.tour.action")}
      </Button>
    </SettingContainer>
  );
};

export default ReplayTour;
