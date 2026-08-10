import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { commands, type SyncStatus } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { isMaxLicense, useMaxStore } from "@/stores/maxStore";

/**
 * Encrypted sync across the user's Macs.
 *
 * Three states, and the copy for each matters more than the layout:
 *
 * - never set up → explain what it does and that the passphrase is
 *   unrecoverable, in those words, before they type one.
 * - set up elsewhere → ask for the passphrase to join this Mac.
 * - running → say when it last synced, and offer the two ways out.
 *
 * The unrecoverability warning is deliberately not a footnote or a tooltip.
 * It is the one fact that turns a support ticket into a permanent loss, and
 * the user has to have read it before the field accepts anything.
 */
export const SyncSection: React.FC = () => {
  const { t } = useTranslation();
  const license = useMaxStore((s) => s.license);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await commands.syncStatus());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!isMaxLicense(license) || status === null) return null;

  const run = async (
    fn: () => Promise<{ status: string; error?: unknown }>,
  ) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.status === "error") {
        toast.error(String(res.error));
        return false;
      }
      setPassphrase("");
      setConfirm("");
      await refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const handleSetup = async () => {
    if (passphrase !== confirm) {
      toast.error(t("sync.mismatch"));
      return;
    }
    if (await run(() => commands.syncSetup(passphrase))) {
      toast.success(t("sync.setupDone"));
      void commands.syncNow();
    }
  };

  const handleUnlock = async () => {
    if (await run(() => commands.syncUnlock(passphrase))) {
      toast.success(t("sync.unlocked"));
      void commands.syncNow();
    }
  };

  const handleSyncNow = async () => {
    setBusy(true);
    try {
      const res = await commands.syncNow();
      if (res.status === "ok") {
        toast.success(
          t("sync.syncedCount", {
            applied: res.data.applied,
            pushed: res.data.pushed,
          }),
        );
        await refresh();
      } else {
        toast.error(String(res.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const running = status.enabled && status.unlocked;

  return (
    <SettingsGroup title={t("sync.title")}>
      <div className="p-4 space-y-4">
        <p className="text-sm text-mid-gray leading-relaxed">
          {t("sync.description")}
        </p>

        {running ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm">
                {status.last_synced_at > 0
                  ? t("sync.lastSynced", {
                      when: new Date(status.last_synced_at).toLocaleString(),
                    })
                  : t("sync.neverSynced")}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSyncNow()}
                disabled={busy}
              >
                <span className="inline-flex items-center gap-1.5">
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {t("sync.syncNow")}
                </span>
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  commands.syncDisable();
                  void refresh();
                }}
                disabled={busy}
              >
                {t("sync.turnOff")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void run(() => commands.syncReset())}
                disabled={busy}
              >
                {t("sync.eraseServerCopy")}
              </Button>
            </div>
            <p className="text-xs text-mid-gray/70 leading-relaxed">
              {t("sync.localSafe")}
            </p>
          </>
        ) : (
          <>
            {/* Not a tooltip and not a footnote. */}
            <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
              <p className="text-sm text-warning leading-relaxed">
                {t("sync.noRecovery")}
              </p>
            </div>

            <div className="space-y-2">
              <Input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("sync.passphrasePlaceholder")}
                className="w-full"
                disabled={busy}
              />
              {!status.set_up && (
                <Input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t("sync.confirmPlaceholder")}
                  className="w-full"
                  disabled={busy}
                />
              )}
            </div>

            <Button
              variant="primary"
              size="md"
              onClick={() =>
                void (status.set_up ? handleUnlock() : handleSetup())
              }
              disabled={busy || passphrase.length < 8}
            >
              {busy
                ? t("sync.working")
                : status.set_up
                  ? t("sync.unlockThisMac")
                  : t("sync.turnOn")}
            </Button>

            <p className="text-xs text-mid-gray/70 leading-relaxed">
              {status.set_up ? t("sync.joinHint") : t("sync.setupHint")}
            </p>
          </>
        )}
      </div>
    </SettingsGroup>
  );
};
