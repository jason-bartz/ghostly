import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "@/bindings";

const PRICING_URL = "https://try-ghostly.com/pricing";

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

  const handleUpgrade = async () => {
    try {
      await openUrl(PRICING_URL);
    } catch (e) {
      console.warn("Failed to open pricing page:", e);
    }
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="bg-background border border-mid-gray/20 rounded-lg shadow-xl max-w-md w-full mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{t("paywall.title")}</h2>
        <p className="text-sm text-mid-gray leading-relaxed">
          {t("paywall.body", { minutes: limitMinutes })}
        </p>
        {resetsAtUnix !== null && (
          <p className="text-xs text-mid-gray">
            {t("paywall.resetsIn", {
              when: formatResetsWhen(resetsAtUnix),
            })}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button
            className="px-3 py-1.5 text-sm rounded-md hover:bg-mid-gray/10 transition-colors"
            onClick={() => setOpen(false)}
          >
            {t("paywall.dismiss")}
          </button>
          <button
            className="px-3 py-1.5 text-sm rounded-md bg-logo-primary text-white hover:opacity-90 transition-opacity"
            onClick={handleUpgrade}
          >
            {t("paywall.upgrade")}
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
