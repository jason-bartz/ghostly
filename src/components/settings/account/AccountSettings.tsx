import React from "react";
import { useTranslation } from "react-i18next";
import { UsageSettings } from "../usage/UsageSettings";
import { LicenseSettings } from "../license/LicenseSettings";
import { MaxAccountSection } from "../max/MaxAccountSection";
import { SyncSection } from "../max/SyncSection";
import { PageHeader } from "../../ui/PageHeader";

/**
 * What you have used and what you have paid for — the two halves of the same
 * question, and the two screens people bounced between when a limit was hit.
 *
 * Stacked rather than switched: usage is a short dashboard and reads as the
 * reason you would scroll to the licence below it.
 */
export const AccountSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl w-full mx-auto space-y-8">
      <PageHeader
        title={t("settings.pages.account.title")}
        description={t("settings.pages.account.subtitle")}
      />
      <UsageSettings />
      <MaxAccountSection />
      <SyncSection />
      <LicenseSettings />
    </div>
  );
};
