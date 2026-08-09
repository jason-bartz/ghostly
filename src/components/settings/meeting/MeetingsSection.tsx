import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { MeetingsLibrary } from "./MeetingsLibrary";
import { MeetingSettings } from "./MeetingSettings";

type Tab = "library" | "settings";

/**
 * The Meetings destination.
 *
 * Library first: once Meeting Mode is configured the thing you come back for is
 * a past meeting, not the toggles — the same reason Notes leads with the list.
 */
export const MeetingsSection: React.FC = () => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("library");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pt-1">
      <SegmentedControl<Tab>
        value={tab}
        onChange={setTab}
        ariaLabel={t("meeting.tabs.ariaLabel")}
        options={[
          { value: "library", label: t("meeting.tabs.library") },
          { value: "settings", label: t("meeting.tabs.settings") },
        ]}
      />
      {tab === "library" ? <MeetingsLibrary /> : <MeetingSettings />}
    </div>
  );
};
