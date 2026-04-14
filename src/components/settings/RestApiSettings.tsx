import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { SettingContainer, SettingsGroup } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { Input } from "../ui/Input";

export const RestApiSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const [portDraft, setPortDraft] = useState<string | null>(null);

  const enabled = getSetting("rest_api_enabled") ?? false;
  const port = getSetting("rest_api_port") ?? 7543;

  const handleToggleEnabled = async (value: boolean) => {
    updateSetting("rest_api_enabled", value);
    const result = await commands.setRestApiEnabled(value);
    if (result.status !== "ok") {
      updateSetting("rest_api_enabled", !value);
      toast.error(String(result.error));
    }
  };

  const handlePortBlur = async () => {
    if (portDraft === null) return;
    const parsed = parseInt(portDraft, 10);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      toast.error(
        t(
          "settings.restApi.invalidPort",
          "Port must be between 1024 and 65535",
        ),
      );
      setPortDraft(null);
      return;
    }
    const result = await commands.setRestApiPort(parsed);
    if (result.status === "ok") {
      updateSetting("rest_api_port", parsed);
    } else {
      toast.error(String(result.error));
    }
    setPortDraft(null);
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.restApi.title", "REST API")}>
        <SettingContainer
          title={t("settings.restApi.enabled.title", "Enable localhost API")}
          description={t(
            "settings.restApi.enabled.description",
            "Expose a local HTTP server for external control (scripts, keyboard maestro, raycast, etc.).",
          )}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
            className="w-4 h-4 cursor-pointer accent-logo-primary"
          />
        </SettingContainer>

        {enabled && (
          <>
            <SettingContainer
              title={t("settings.restApi.port.title", "Port")}
              description={t(
                "settings.restApi.port.description",
                "The port the API listens on. Default: 7543. Requires restart to take effect.",
              )}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <Input
                type="number"
                value={portDraft ?? String(port)}
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={handlePortBlur}
                min={1024}
                max={65535}
                variant="compact"
                className="w-28"
              />
            </SettingContainer>

            <SettingContainer
              title={t("settings.restApi.docs.title", "Endpoints")}
              description={t(
                "settings.restApi.docs.description",
                "API reference for available HTTP endpoints.",
              )}
              descriptionMode="tooltip"
              layout="stacked"
              grouped={true}
            >
              <div className="text-xs font-mono space-y-1 text-mid-gray/80 bg-mid-gray/5 rounded-md p-3 border border-mid-gray/20">
                {[
                  {
                    method: "POST",
                    path: "/api/transcribe/start",
                    desc: t(
                      "settings.restApi.endpoint.transcribeStart",
                      "Start/toggle transcription",
                    ),
                  },
                  {
                    method: "POST",
                    path: "/api/transcribe/stop",
                    desc: t(
                      "settings.restApi.endpoint.transcribeStop",
                      "Stop transcription",
                    ),
                  },
                  {
                    method: "POST",
                    path: "/api/cancel",
                    desc: t(
                      "settings.restApi.endpoint.cancel",
                      "Cancel current operation",
                    ),
                  },
                  {
                    method: "POST",
                    path: "/api/paste",
                    desc: t(
                      "settings.restApi.endpoint.paste",
                      'Paste text (body: {"text":"…"})',
                    ),
                  },
                  {
                    method: "GET",
                    path: "/api/history",
                    desc: t(
                      "settings.restApi.endpoint.history",
                      "Recent history entries",
                    ),
                  },
                  {
                    method: "GET",
                    path: "/api/status",
                    desc: t("settings.restApi.endpoint.status", "App status"),
                  },
                ].map(({ method, path, desc }) => (
                  <div key={path} className="flex gap-3 items-start">
                    <span
                      className={`shrink-0 font-bold ${
                        method === "GET" ? "text-blue-400" : "text-green-400"
                      }`}
                    >
                      {method}
                    </span>
                    <span className="shrink-0 text-text/90">
                      http://127.0.0.1:{port}
                      {path}
                    </span>
                    <span className="text-mid-gray/60">{desc}</span>
                  </div>
                ))}
              </div>
            </SettingContainer>
          </>
        )}
      </SettingsGroup>
    </div>
  );
};
