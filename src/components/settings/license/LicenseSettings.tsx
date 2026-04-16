import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Loader2 } from "lucide-react";
import {
  commands,
  type LicenseState,
  type LicenseError,
  type StatusResponse,
  type ActiveDevice,
} from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

function formatRelativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diff < 86400 * 30) {
    const d = Math.floor(diff / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function errorKey(err: LicenseError): string {
  switch (err.code) {
    case "invalid_key":
      return "license.errors.invalidKey";
    case "revoked":
      return "license.errors.revoked";
    case "device_limit_reached":
      return "license.errors.deviceLimitReached";
    case "not_activated":
      return "license.errors.notActivated";
    case "network_error":
      return "license.errors.networkError";
    case "invalid_token":
      return "license.errors.invalidToken";
    case "not_ready":
      return "license.errors.notReady";
    default:
      return "license.errors.networkError";
  }
}

function formatExpires(unix: number | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (unix === null) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = unix - now;
  if (diff <= 0) return t("license.expiresIn", { when: t("license.expired") });
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const when = days > 0 ? `${days}d` : `${hours}h`;
  return t("license.expiresIn", { when });
}

export const LicenseSettings: React.FC = () => {
  const { t } = useTranslation();
  const [state, setState] = useState<LicenseState | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LicenseError | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [devices, setDevices] = useState<StatusResponse | null>(null);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const refreshState = useCallback(async () => {
    const s = await commands.getLicenseState();
    setState(s);
    return s;
  }, []);

  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await commands.getDeviceList();
      if (res.status === "ok") {
        setDevices(res.data);
      }
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshState().then((s) => {
      if (s.is_licensed) void refreshDevices();
    });
  }, [refreshState, refreshDevices]);

  const handleActivate = useCallback(
    async (rawKey: string) => {
      const key = rawKey.trim();
      if (!key) return;
      setBusy(true);
      setError(null);
      setErrorMessage(null);
      const res = await commands.activateLicense(key);
      setBusy(false);
      if (res.status === "ok") {
        setState(res.data);
        setKeyInput("");
        void refreshDevices();
      } else {
        setError(res.error as LicenseError);
        if ((res.error as LicenseError).code === "network_error") {
          setErrorMessage((res.error as { message?: string }).message ?? null);
        }
      }
    },
    [refreshDevices],
  );

  useEffect(() => {
    const unlisten = listen<string>("license-auto-activate", async (event) => {
      const sessionId = event.payload;
      setBusy(true);
      setError(null);
      setErrorMessage(null);
      const res = await commands.activateFromSession(sessionId);
      setBusy(false);
      if (res.status === "ok") {
        setState(res.data);
        void refreshDevices();
      } else {
        setError(res.error as LicenseError);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshDevices]);

  const handleDeactivateThis = useCallback(async () => {
    setBusy(true);
    const res = await commands.deactivateLicense();
    setBusy(false);
    if (res.status === "ok") {
      setDevices(null);
      await refreshState();
    }
  }, [refreshState]);

  const handleDeactivateRemote = useCallback(
    async (mid: string) => {
      setBusy(true);
      const res = await commands.deactivateRemoteDevice(mid);
      setBusy(false);
      if (res.status === "ok") {
        await refreshDevices();
      } else {
        setError(res.error as LicenseError);
      }
    },
    [refreshDevices],
  );

  const handleBuy = useCallback(async () => {
    await commands.openPaymentLink();
  }, []);

  if (state === null) {
    return (
      <div className="max-w-3xl w-full mx-auto flex items-center justify-center py-12 text-mid-gray">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="text-sm text-mid-gray/70 leading-relaxed">
        {t("license.description")}
      </div>

      {!state.is_licensed && (
        <SettingsGroup title={t("license.title")}>
          <div className="p-4 space-y-3">
            <label className="text-xs font-medium text-mid-gray uppercase tracking-wide block">
              {t("license.keyLabel")}
            </label>
            <Input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t("license.keyPlaceholder")}
              className="w-full font-mono"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleActivate(keyInput);
              }}
            />
            {error !== null && (
              <ErrorBlock
                error={error}
                errorMessage={errorMessage}
                onDeactivateRemote={handleDeactivateRemote}
              />
            )}
            <div className="flex gap-2 pt-1">
              <Button
                variant="primary"
                onClick={() => void handleActivate(keyInput)}
                disabled={busy || keyInput.trim().length === 0}
              >
                {busy ? t("license.activating") : t("license.activate")}
              </Button>
              <Button variant="secondary" onClick={() => void handleBuy()}>
                {t("license.buy")}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      )}

      {state.is_licensed && (
        <>
          <SettingsGroup title={t("license.activeTitle")}>
            <div className="p-4 space-y-3 text-sm">
              <Row label={t("license.keyLabel")} value={state.key_masked ?? ""} mono />
              {state.email !== null && (
                <Row label={t("license.email")} value={state.email} />
              )}
              {state.expires_at !== null && (
                <Row
                  label={t("license.renewsLabel")}
                  value={formatExpires(state.expires_at, t)}
                />
              )}
            </div>
          </SettingsGroup>

          <SettingsGroup title={t("license.deviceList")}>
            <DevicesSection
              devices={devices}
              loading={devicesLoading}
              currentMachineId={state.machine_id}
              onRefresh={refreshDevices}
              onDeactivate={handleDeactivateRemote}
              busy={busy}
            />
          </SettingsGroup>

          <SettingsGroup title={t("license.dangerZone")}>
            <div className="p-4">
              <Button
                variant="danger"
                onClick={() => void handleDeactivateThis()}
                disabled={busy}
              >
                {t("license.deactivateThisDevice")}
              </Button>
              <p className="text-xs text-mid-gray mt-2">
                {t("license.deactivateThisDeviceHelp")}
              </p>
            </div>
          </SettingsGroup>
        </>
      )}
    </div>
  );
};

interface ErrorBlockProps {
  readonly error: LicenseError;
  readonly errorMessage: string | null;
  readonly onDeactivateRemote: (mid: string) => void;
}

const ErrorBlock: React.FC<ErrorBlockProps> = ({
  error,
  errorMessage,
  onDeactivateRemote,
}) => {
  const { t } = useTranslation();
  return (
    <div className="p-3 rounded-md border border-red-500/30 bg-red-500/10 text-sm space-y-2">
      <p className="text-red-400">{t(errorKey(error))}</p>
      {errorMessage !== null && (
        <p className="text-xs text-mid-gray">{errorMessage}</p>
      )}
      {error.code === "device_limit_reached" && (
        <div className="space-y-2 pt-1">
          <p className="text-xs text-mid-gray">
            {t("license.errors.deviceLimitHelp", { limit: error.limit })}
          </p>
          <div className="divide-y divide-mid-gray/20 border border-mid-gray/20 rounded">
            {error.active_devices.map((d, i) => (
              <div
                key={`${d.machine_id ?? i}-${i}`}
                className="flex items-center justify-between p-2 gap-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">{d.machine_name}</p>
                  {d.last_validated_at != null && (
                    <p className="text-xs text-mid-gray truncate">
                      {formatRelativeTime(d.last_validated_at)}
                    </p>
                  )}
                </div>
                {d.machine_id !== null && (
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => onDeactivateRemote(d.machine_id as string)}
                  >
                    {t("license.deactivateDevice")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

interface DevicesSectionProps {
  readonly devices: StatusResponse | null;
  readonly loading: boolean;
  readonly currentMachineId: string;
  readonly onRefresh: () => void;
  readonly onDeactivate: (mid: string) => void;
  readonly busy: boolean;
}

const DevicesSection: React.FC<DevicesSectionProps> = ({
  devices,
  loading,
  currentMachineId,
  onRefresh,
  onDeactivate,
  busy,
}) => {
  const { t } = useTranslation();
  if (loading && devices === null) {
    return (
      <div className="p-4 flex items-center justify-center text-mid-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    );
  }
  if (devices === null) {
    return (
      <div className="p-4 flex items-center justify-between">
        <p className="text-sm text-mid-gray">{t("license.deviceListUnavailable")}</p>
        <Button variant="secondary" size="sm" onClick={onRefresh}>
          {t("license.retry")}
        </Button>
      </div>
    );
  }
  return (
    <div>
      {devices.active_devices.length === 0 ? (
        <p className="p-4 text-sm text-mid-gray">{t("license.noDevices")}</p>
      ) : (
        devices.active_devices.map((d: ActiveDevice, i) => {
          const isCurrent = d.machine_id === currentMachineId;
          return (
            <div
              key={`${d.machine_id ?? i}-${i}`}
              className="px-4 py-3 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium text-sm">{d.machine_name}</p>
                  {isCurrent && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-logo-primary/15 text-logo-primary">
                      {t("license.currentDevice")}
                    </span>
                  )}
                </div>
                {d.last_validated_at != null && (
                  <p className="text-xs text-mid-gray truncate">
                    {t("license.lastSeen", {
                      when: formatRelativeTime(d.last_validated_at),
                    })}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="danger-ghost"
                disabled={busy || isCurrent || d.machine_id === null}
                onClick={() =>
                  d.machine_id !== null && onDeactivate(d.machine_id)
                }
              >
                {t("license.deactivateDevice")}
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
};

interface RowProps {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

const Row: React.FC<RowProps> = ({ label, value, mono }) => (
  <div className="flex items-start justify-between gap-4">
    <p className="text-xs text-mid-gray uppercase tracking-wide pt-0.5">{label}</p>
    <p className={`text-sm text-right ${mono ? "font-mono" : ""}`}>{value}</p>
  </div>
);
