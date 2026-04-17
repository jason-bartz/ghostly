import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { AppDataDirectory } from "../AppDataDirectory";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { LogDirectory } from "../debug";
import { LegalViewer } from "./LegalViewer";
import { UpdateCheckRow } from "./UpdateCheckRow";
import { commands } from "@/bindings";

type ViewerKind = "eula" | "notices" | null;

const unwrap = async <T,>(
  p: Promise<{ status: string; data?: T; error?: unknown }>,
): Promise<T> => {
  const r = await p;
  if (r.status === "ok" && r.data !== undefined) return r.data;
  throw new Error(String(r.error ?? "unknown error"));
};

export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const [viewer, setViewer] = useState<ViewerKind>(null);

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("0.1.2");
      }
    };

    fetchVersion();
  }, []);

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.about.title")}>
        <AppLanguageSelector descriptionMode="tooltip" grouped={true} />
        <SettingContainer
          title={t("settings.about.version.title")}
          description={t("settings.about.version.description")}
          grouped={true}
        >
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span className="text-sm font-mono">v{version}</span>
        </SettingContainer>
        <UpdateCheckRow currentVersion={version} />
        <AppDataDirectory descriptionMode="tooltip" grouped={true} />
        <LogDirectory grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.about.acknowledgments.title")}>
        <SettingContainer
          title={t("settings.about.acknowledgments.eula.title")}
          description={t("settings.about.acknowledgments.eula.description")}
          grouped={true}
          layout="stacked"
        >
          <button
            onClick={() => setViewer("eula")}
            className="text-sm text-mid-gray underline hover:text-text text-left"
          >
            {t("settings.about.acknowledgments.eula.link")}
          </button>
        </SettingContainer>
        <SettingContainer
          title={t("settings.about.acknowledgments.notices.title")}
          description={t("settings.about.acknowledgments.notices.description")}
          grouped={true}
          layout="stacked"
        >
          <button
            onClick={() => setViewer("notices")}
            className="text-sm text-mid-gray underline hover:text-text text-left"
          >
            {t("settings.about.acknowledgments.notices.link")}
          </button>
        </SettingContainer>
      </SettingsGroup>

      {viewer === "eula" && (
        <LegalViewer
          title={t("settings.about.acknowledgments.eula.title")}
          load={async () => {
            const [text] = await unwrap(commands.getEula());
            return text;
          }}
          onClose={() => setViewer(null)}
        />
      )}
      {viewer === "notices" && (
        <LegalViewer
          title={t("settings.about.acknowledgments.notices.title")}
          load={() => unwrap(commands.getThirdPartyNotices())}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
};
