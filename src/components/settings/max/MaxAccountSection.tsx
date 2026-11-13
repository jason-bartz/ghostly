import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { commands, type AiStatus } from "@/bindings";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Button } from "../../ui/Button";
import { useMaxStore, isMaxAccount } from "@/stores/maxStore";
import { maxReasonKey } from "@/lib/maxErrors";

/**
 * The Max half of the Account pane: entitlement plus how much of the month's
 * fair-use allowance is spent.
 *
 * Rendered for any Max subscription, lapsed included — a lapsed subscriber is
 * exactly who needs the reason and the billing button. The count comes from
 * the gateway, so it can be unavailable while offline — that shows as a quiet
 * line rather than an error, because the subscription is fine and only the
 * number is missing.
 */
export const MaxAccountSection: React.FC = () => {
  const { t } = useTranslation();
  const license = useMaxStore((s) => s.license);
  const aiStatus = useMaxStore((s) => s.aiStatus);
  const loading = useMaxStore((s) => s.loading);
  const refresh = useMaxStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!isMaxAccount(license)) return null;

  return (
    <SettingsGroup title={t("max.account.title")}>
      <div className="p-4 space-y-4">
        {loading && aiStatus === null ? (
          <div className="flex items-center justify-center py-2 text-mid-gray">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : aiStatus === null ? (
          <p className="text-sm text-mid-gray">{t("max.account.offline")}</p>
        ) : (
          <>
            {/* A spent allowance leaves entitlement intact, so the gateway
                reports `ok` — the bar below is at 100% but nothing would say
                why requests are being refused. */}
            {!aiStatus.ai_enabled ? (
              <p className="text-sm text-warning">
                {t(maxReasonKey(aiStatus.reason))}
              </p>
            ) : allowanceFraction(aiStatus) >= 1 ? (
              <p className="text-sm text-warning">
                {t("max.errors.fairUseExceeded")}
              </p>
            ) : null}
            <QuotaBar status={aiStatus} />
          </>
        )}

        <ManageBillingRow />
      </div>
    </SettingsGroup>
  );
};

/**
 * One button out to Stripe's Customer Portal — card, invoices, cancellation.
 *
 * Deliberately not reimplemented in-app: none of it can be done without
 * handling payment details, and all of it changes whenever Stripe changes.
 */
const ManageBillingRow: React.FC = () => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const handleOpen = async () => {
    setBusy(true);
    try {
      const res = await commands.openBillingPortal();
      if (res.status === "error") {
        // `not_ready` is the gateway saying this licence has no Stripe customer
        // behind it — a perpetual Pro key. That is not a failure worth alarming
        // about, it just means there is no subscription to manage.
        toast.error(
          res.error.code === "not_ready"
            ? t("max.account.noSubscription")
            : t("max.account.portalFailed"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 pt-1">
      <p className="text-sm text-mid-gray">{t("max.account.manageHelp")}</p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleOpen()}
        disabled={busy}
      >
        <span className="inline-flex items-center gap-1.5">
          {busy ? t("max.account.opening") : t("max.account.manage")}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </span>
      </Button>
    </div>
  );
};

/**
 * Share of the month's allowance spent, 0–1.
 *
 * Prefers the gateway's combined figure, which covers requests, tokens and
 * dollars — whichever trips first is what refuses the next request. The bare
 * request count is the fallback for a Worker that predates it.
 */
const allowanceFraction = (status: AiStatus): number => {
  if (typeof status.allowance_used_pct === "number") {
    return Math.min(1, Math.max(0, status.allowance_used_pct / 100));
  }
  return status.requests_limit > 0
    ? Math.min(1, Math.max(0, status.requests_used / status.requests_limit))
    : 0;
};

interface QuotaBarProps {
  readonly status: AiStatus;
}

const QuotaBar: React.FC<QuotaBarProps> = ({ status }) => {
  const { t } = useTranslation();
  const pct = allowanceFraction(status);
  const combined = typeof status.allowance_used_pct === "number";

  // The allowance is set well above heavy human use, so a bar that is nearly
  // empty is the expected reading. Warning colour only near the top, where it
  // actually means something.
  const barColor =
    pct >= 1 ? "bg-danger" : pct >= 0.8 ? "bg-warning" : "bg-accent";

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium text-mid-gray uppercase tracking-wide">
          {combined
            ? t("max.account.allowanceTitle")
            : t("max.account.requestsTitle")}
        </p>
        <p className="text-sm tabular-nums">
          {combined
            ? t("max.account.allowanceValue", { pct: Math.round(pct * 100) })
            : t("max.account.requestsValue", {
                used: status.requests_used.toLocaleString(),
                limit: status.requests_limit.toLocaleString(),
              })}
        </p>
      </div>
      <div className="h-2 w-full rounded-full bg-fill-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
          style={{ width: `${Math.round(pct * 100)}%` }}
          aria-hidden
        />
      </div>
      <p className="text-xs text-mid-gray/70 leading-relaxed">
        {t("max.account.requestsHelp")}
      </p>
    </div>
  );
};
