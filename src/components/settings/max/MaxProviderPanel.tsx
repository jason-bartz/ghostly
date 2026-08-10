import React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Sparkles } from "lucide-react";
import type { AiStatus } from "@/bindings";
import { Button } from "../../ui/Button";
import { maxReasonKey } from "@/lib/maxErrors";

/**
 * What a Max subscriber sees where the provider picker, model picker, and
 * API-key field would be.
 *
 * There is deliberately nothing to configure here. The entire proposition of
 * the subscription is that the configuration screen goes away — a Max user who
 * is shown three dropdowns has been sold the same thing as the free tier with
 * a bill attached. The one control is the escape hatch below it, collapsed by
 * default.
 */
interface MaxProviderPanelProps {
  readonly status: AiStatus | null;
  readonly onOpenAccount: () => void;
  /**
   * Provider actually handling refinement right now. Normally Ghostly Max, but
   * a subscriber can end up elsewhere — they had a provider selected before
   * subscribing on a second Mac, or picked one in the debug pane. The panel
   * says so rather than claiming Max is in use when it isn't.
   */
  readonly activeProviderLabel: string | null;
  readonly onUseMax: () => void;
}

export const MaxProviderPanel: React.FC<MaxProviderPanelProps> = ({
  status,
  onOpenAccount,
  activeProviderLabel,
  onUseMax,
}) => {
  const { t } = useTranslation();

  // When `/ai/status` is unreachable, `status` is null and the panel shows the
  // healthy state — the offline token already said this user is on Max, and a
  // real request will report a real failure if there is one.
  const lapsed = status !== null && !status.ai_enabled;

  // A spent allowance is not an entitlement problem, so the gateway still
  // reports `ai_enabled: true` and `reason: "ok"` — correctly. But refinement
  // is nonetheless being refused, so "Connected and ready" would be a lie.
  const atCap =
    status !== null &&
    status.ai_enabled &&
    status.requests_limit > 0 &&
    status.requests_used >= status.requests_limit;

  return (
    <div className="space-y-3">
      <div className="surface-card rounded-xl p-5 space-y-3">
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 shrink-0 text-accent-bright mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("max.provider.title")}</p>
            <p className="text-sm text-mid-gray leading-relaxed">
              {t("max.provider.description")}
            </p>
          </div>
        </div>

        {activeProviderLabel !== null ? (
          <div className="flex items-start gap-2 pt-1">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
            <div className="space-y-2">
              <p className="text-sm text-warning">
                {t("max.provider.notActive", {
                  provider: activeProviderLabel,
                })}
              </p>
              <Button variant="secondary" size="sm" onClick={onUseMax}>
                {t("max.provider.useMax")}
              </Button>
            </div>
          </div>
        ) : lapsed ? (
          <div className="flex items-start gap-2 pt-1">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
            <div className="space-y-2">
              <p className="text-sm text-warning">
                {t(maxReasonKey(status.reason))}
              </p>
              <Button variant="secondary" size="sm" onClick={onOpenAccount}>
                {t("max.provider.manageSubscription")}
              </Button>
            </div>
          </div>
        ) : atCap ? (
          <div className="flex items-start gap-2 pt-1">
            <AlertCircle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
            <p className="text-sm text-warning">
              {t("max.errors.fairUseExceeded")}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 pt-1">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <p className="text-sm">{t("max.provider.ready")}</p>
          </div>
        )}
      </div>

      <p className="text-xs text-mid-gray/70 leading-relaxed">
        {t("max.provider.privacyNote")}
      </p>
    </div>
  );
};
