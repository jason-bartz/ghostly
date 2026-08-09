import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { commands } from "@/bindings";
import { SettingContainer, SettingsGroup, ToggleSwitch } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type Endpoint = {
  method: "GET" | "POST";
  path: string;
  descriptionKey: string;
  body?: string;
};

const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/api/status", descriptionKey: "status" },
  {
    method: "POST",
    path: "/api/dictate",
    descriptionKey: "dictate",
  },
  {
    method: "POST",
    path: "/api/transcribe/start",
    descriptionKey: "transcribeStart",
  },
  {
    method: "POST",
    path: "/api/transcribe/stop",
    descriptionKey: "transcribeStop",
  },
  {
    method: "POST",
    path: "/api/transcribe/toggle",
    descriptionKey: "transcribeToggle",
  },
  { method: "POST", path: "/api/cancel", descriptionKey: "cancel" },
  {
    method: "POST",
    path: "/api/paste",
    descriptionKey: "paste",
    body: '{"text":"hello"}',
  },
  { method: "GET", path: "/api/history", descriptionKey: "history" },
  { method: "GET", path: "/api/events", descriptionKey: "events" },
];

/** A short prefix is enough to recognise the token without displaying it. */
const maskToken = (token: string) =>
  token.length > 8 ? `${token.slice(0, 8)}${"•".repeat(24)}` : token;

export const RestApiSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting } = useSettings();
  const [portDraft, setPortDraft] = useState<string | null>(null);
  const [token, setToken] = useState<string>("");
  const [tokenRevealed, setTokenRevealed] = useState(false);
  const [runningPort, setRunningPort] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [cliPath, setCliPath] = useState<string | null>(null);

  const enabled = getSetting("rest_api_enabled") ?? false;
  const port = getSetting("rest_api_port") ?? 7543;

  const refreshRunningPort = useCallback(async () => {
    setRunningPort(await commands.restApiRunningPort());
  }, []);

  useEffect(() => {
    void refreshRunningPort();
    void commands.cliInstallStatus().then(setCliPath);
  }, [refreshRunningPort]);

  useEffect(() => {
    if (!enabled) return;
    void commands.getRestApiToken().then((result) => {
      if (result.status === "ok") setToken(result.data);
    });
  }, [enabled]);

  const copy = async (value: string, key: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const handleToggleEnabled = async (value: boolean) => {
    setBusy(true);
    const result = await commands.setRestApiEnabled(value);
    setBusy(false);
    if (result.status === "ok") {
      updateSetting("rest_api_enabled", value);
    } else {
      toast.error(String(result.error));
    }
    void refreshRunningPort();
  };

  const handlePortBlur = async () => {
    if (portDraft === null) return;
    const parsed = parseInt(portDraft, 10);
    if (isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      toast.error(t("settings.restApi.invalidPort"));
      setPortDraft(null);
      return;
    }
    if (parsed === port) {
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
    void refreshRunningPort();
  };

  const handleRegenerate = async () => {
    if (!window.confirm(t("settings.restApi.token.regenerateConfirm"))) return;
    const result = await commands.regenerateRestApiToken();
    if (result.status === "ok") {
      setToken(result.data);
      toast.success(t("settings.restApi.token.regenerated"));
    } else {
      toast.error(String(result.error));
    }
  };

  const handleTest = async () => {
    setBusy(true);
    // Deliberately not a fetch from here: this settings pane runs in a
    // webview, and the API refuses anything that looks like a browser. A
    // fetch would come back 403 on a perfectly healthy server. Ask the
    // backend which port it actually has bound instead.
    const actual = await commands.restApiRunningPort();
    setRunningPort(actual);
    setBusy(false);

    if (actual === null) {
      toast.error(t("settings.restApi.test.notListening"));
    } else if (actual !== port) {
      toast.error(t("settings.restApi.test.portMismatch", { actual }));
    } else {
      toast.success(t("settings.restApi.test.ok", { port }));
    }
  };

  const handleInstallCli = async () => {
    setBusy(true);
    const result = await commands.installCli();
    setBusy(false);
    if (result.status !== "ok") {
      toast.error(String(result.error));
      return;
    }
    setCliPath(result.data.path);
    if (result.data.path_hint) {
      toast.success(t("settings.restApi.cli.installedNeedsPath"), {
        description: result.data.path_hint,
        duration: 10000,
      });
    } else {
      toast.success(
        t("settings.restApi.cli.installed", { path: result.data.path }),
      );
    }
  };

  const curlFor = (endpoint: Endpoint) => {
    const parts = [
      "curl",
      endpoint.method === "POST" ? "-X POST" : null,
      `http://127.0.0.1:${port}${endpoint.path}`,
      `-H "Authorization: Bearer ${token || "<token>"}"`,
      endpoint.body ? `-H "Content-Type: application/json"` : null,
      endpoint.body ? `-d '${endpoint.body}'` : null,
    ].filter(Boolean);
    return parts.join(" ");
  };

  const listening = runningPort !== null;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup
        title={t("settings.restApi.cli.sectionTitle")}
        description={t("settings.restApi.cli.sectionDescription")}
      >
        <SettingContainer
          title={t("settings.restApi.cli.install.title")}
          description={t("settings.restApi.cli.install.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped
        >
          <div className="flex items-center gap-2">
            {cliPath && (
              <span className="text-xs text-success inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                {t("settings.restApi.cli.installedAt", { path: cliPath })}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={handleInstallCli}
              disabled={busy}
            >
              <span className="inline-flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" />
                {cliPath
                  ? t("settings.restApi.cli.reinstall")
                  : t("settings.restApi.cli.installAction")}
              </span>
            </Button>
          </div>
        </SettingContainer>

        <SettingContainer
          title={t("settings.restApi.cli.examples.title")}
          description={t("settings.restApi.cli.examples.description")}
          descriptionMode="tooltip"
          layout="stacked"
          grouped
        >
          <div className="text-xs font-mono space-y-1.5 text-mid-gray/80 bg-fill-2 rounded-md p-3 border border-hairline-strong">
            {[
              ["ghostly --toggle-transcription", "toggle"],
              ["ghostly --dictate", "dictate"],
              ['git commit -m "$(ghostly --dictate)"', "compose"],
              ["ghostly --history --limit 5", "history"],
            ].map(([command, key]) => (
              <div key={key} className="flex gap-3 items-baseline">
                <code className="text-text/90 shrink-0">{command}</code>
                <span className="text-mid-gray/60">
                  {t(`settings.restApi.cli.examples.${key}`)}
                </span>
              </div>
            ))}
          </div>
        </SettingContainer>
      </SettingsGroup>

      <SettingsGroup
        title={t("settings.restApi.title")}
        description={t("settings.restApi.sectionDescription")}
      >
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggleEnabled}
          disabled={busy}
          label={t("settings.restApi.enabled.title")}
          description={t("settings.restApi.enabled.description")}
          descriptionMode="tooltip"
          grouped
        />

        {enabled && (
          <>
            <SettingContainer
              title={t("settings.restApi.port.title")}
              description={t("settings.restApi.port.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped
            >
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs inline-flex items-center gap-1.5 ${
                    listening ? "text-success" : "text-danger"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      listening ? "bg-success" : "bg-danger"
                    }`}
                  />
                  {listening
                    ? t("settings.restApi.listening", { port: runningPort })
                    : t("settings.restApi.notListening")}
                </span>
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
              </div>
            </SettingContainer>

            <SettingContainer
              title={t("settings.restApi.token.title")}
              description={t("settings.restApi.token.description")}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped
            >
              <div className="flex items-center gap-2">
                <code
                  className="text-xs font-mono text-mid-gray/80 bg-fill-2 rounded px-2 py-1 border border-hairline-strong cursor-pointer select-all"
                  onClick={() => setTokenRevealed((v) => !v)}
                  title={t("settings.restApi.token.revealHint")}
                >
                  {tokenRevealed ? token : maskToken(token)}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => copy(token, "token")}
                  disabled={!token}
                >
                  {copied === "token" ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRegenerate}
                  title={t("settings.restApi.token.regenerate")}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </Button>
              </div>
            </SettingContainer>

            <SettingContainer
              title={t("settings.restApi.docs.title")}
              description={t("settings.restApi.docs.description")}
              descriptionMode="tooltip"
              layout="stacked"
              grouped
            >
              <div className="space-y-2">
                <div className="text-xs font-mono space-y-1 text-mid-gray/80 bg-fill-2 rounded-md p-3 border border-hairline-strong">
                  {ENDPOINTS.map((endpoint) => (
                    <div
                      key={endpoint.path}
                      className="flex gap-3 items-start group"
                    >
                      <span
                        className={`shrink-0 font-bold w-10 ${
                          endpoint.method === "GET"
                            ? "text-accent-alt"
                            : "text-success"
                        }`}
                      >
                        {endpoint.method}
                      </span>
                      <span className="shrink-0 text-text/90">
                        {endpoint.path}
                      </span>
                      <span className="text-mid-gray/60 flex-1 min-w-0">
                        {t(
                          `settings.restApi.endpoint.${endpoint.descriptionKey}`,
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => copy(curlFor(endpoint), endpoint.path)}
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-mid-gray/70 hover:text-text cursor-pointer"
                        title={t("settings.restApi.copyCurl")}
                      >
                        {copied === endpoint.path ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleTest}
                    disabled={busy}
                  >
                    {t("settings.restApi.test.action")}
                  </Button>
                  <span className="text-xs text-mid-gray/60">
                    {t("settings.restApi.securityNote")}
                  </span>
                </div>
              </div>
            </SettingContainer>
          </>
        )}
      </SettingsGroup>
    </div>
  );
};
