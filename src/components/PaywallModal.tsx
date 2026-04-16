import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";

export const PaywallModal: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [resetsAtUnix, setResetsAtUnix] = useState<number | null>(null);
  const [limitMinutes, setLimitMinutes] = useState<number>(30);

  useEffect(() => {
    const unlisten = listen("usage-limit-reached", async () => {
      const res = await commands.getUsageStats();
      if (res.status === "ok") {
        setResetsAtUnix(res.data.resets_at_unix);
        setLimitMinutes(Math.round(res.data.weekly_limit_secs / 60));
      }
      setOpen(true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  if (!open) return null;

  const handleBuy = async () => {
    try {
      await commands.openPaymentLink();
    } catch (e) {
      console.warn("Failed to open payment link:", e);
    }
    setOpen(false);
  };

  const handleHaveKey = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("ghostly-navigate-to-license"));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={() => setOpen(false)}
    >
      <div
        className="surface-card-inlay !rounded-2xl max-w-md w-full mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <span className="tag-pill mb-3">{t("sidebar.usage")}</span>
          <h2 className="text-xl font-display tracking-tight text-text mt-2">
            {t("paywall.title")}
          </h2>
        </div>
        <p className="text-[13px] text-text-muted leading-relaxed">
          {t("paywall.body", { minutes: limitMinutes })}
        </p>
        {resetsAtUnix !== null && (
          <p className="text-xs text-text-faint">
            {t("paywall.resetsIn", {
              when: formatResetsWhen(resetsAtUnix),
            })}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2 flex-wrap">
          <button
            className="px-3.5 py-1.5 text-xs font-medium rounded-full text-text-muted hover:text-text hover:bg-white/[0.04] transition-colors"
            onClick={() => setOpen(false)}
          >
            {t("paywall.dismiss")}
          </button>
          <button
            className="px-3.5 py-1.5 text-xs font-medium rounded-full border border-hairline-strong text-text hover:bg-white/[0.04] transition-colors"
            onClick={handleHaveKey}
          >
            {t("paywall.haveKey")}
          </button>
          <button
            className="px-4 py-1.5 text-xs font-medium rounded-full bg-accent-deep hover:bg-background-ui-hover text-white transition-colors btn-glow"
            onClick={handleBuy}
          >
            {t("paywall.buyButton")}
          </button>
        </div>
      </div>
    </div>
  );
};

function formatResetsWhen(unix: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = unix - now;
  if (diff <= 0) return "soon";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days > 0) return `in ${days}d ${hours}h`;
  return `in ${hours}h`;
}
