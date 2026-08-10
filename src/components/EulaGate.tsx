import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { Button } from "@/components/ui/Button";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { MarkdownLite } from "@/components/ui/MarkdownLite";

type Props = {
  onAccepted: () => void;
};

export function EulaGate({ onAccepted }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [scrolledToEnd, setScrolledToEnd] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [shake, setShake] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await commands.getEula();
        if (cancelled) return;
        if (result.status === "ok") {
          const [eulaText, ver] = result.data;
          setText(eulaText);
          setVersion(ver);
        } else {
          setError(String(result.error));
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!text) return;
    // Re-check on mount in case content is shorter than the viewport.
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 16) {
      setScrolledToEnd(true);
      setScrollProgress(1);
    }
  }, [text]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    setScrollProgress(Math.min(1, el.scrollTop / max));
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 16) {
      setScrolledToEnd(true);
    }
  };

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const result = await commands.acceptEula(version);
      if (result.status === "ok") {
        onAccepted();
      } else {
        setError(String(result.error));
        setAccepting(false);
      }
    } catch (e) {
      setError(String(e));
      setAccepting(false);
    }
  };

  const handleDecline = async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  const handleAcceptGuardClick = () => {
    if (scrolledToEnd || accepting || text === null) return;
    toast.message(t("eula.mustReadHint"));
    setShake(true);
    const el = scrollRef.current;
    if (el) el.scrollBy({ top: 120, behavior: "smooth" });
    window.setTimeout(() => setShake(false), 450);
  };

  return (
    <div className="app-canvas fixed inset-0 z-50 flex items-center justify-center modal-scrim p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="eula-title"
        className={`w-full max-w-2xl h-[85vh] max-h-[760px] flex flex-col rounded-2xl glass-raised overflow-hidden ${
          shake ? "animate-[shake_0.4s_ease-in-out]" : ""
        }`}
      >
        <div className="px-8 pt-7 pb-5 border-b border-hairline">
          <h1
            id="eula-title"
            className="text-2xl font-display tracking-tight text-text"
          >
            {t("eula.title")}
          </h1>
          <p className="text-[13px] text-text-muted mt-1.5">
            {t("eula.intro")}
          </p>
          {version ? (
            <p className="text-[11px] text-text-faint mt-2 tracking-wide uppercase">
              {t("eula.version", { version })}
            </p>
          ) : null}
        </div>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto px-8 py-6 bg-canvas/40"
        >
          {error ? (
            <p className="text-danger text-sm">{t("eula.loadError")}</p>
          ) : text === null ? (
            <p className="text-sm text-text-muted">…</p>
          ) : (
            <MarkdownLite
              source={text}
              className="prose-eula text-[13.5px] leading-relaxed text-text-muted space-y-3"
            />
          )}
        </div>

        <div
          className="h-1 bg-surface-1 border-t border-hairline"
          role="progressbar"
          aria-label={t("eula.scrollProgressLabel")}
          aria-valuenow={Math.round(scrollProgress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full transition-[width] duration-150 ${scrolledToEnd ? "bg-accent-bright" : "bg-accent-deep"}`}
            style={{ width: `${Math.round(scrollProgress * 100)}%` }}
          />
        </div>

        <div className="px-8 py-4 flex items-center justify-between gap-4 border-t border-hairline bg-surface-1">
          <p
            className={`text-xs transition-colors ${
              scrolledToEnd ? "text-accent-bright" : "text-text-faint"
            }`}
          >
            {scrolledToEnd ? t("eula.scrolledPrompt") : t("eula.scrollHint")}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDecline}>
              {t("eula.decline")}
            </Button>
            <span
              onClick={handleAcceptGuardClick}
              className={!scrolledToEnd ? "cursor-not-allowed" : undefined}
            >
              <Button
                variant="primary"
                disabled={!scrolledToEnd || accepting || text === null}
                onClick={handleAccept}
              >
                {t("eula.accept")}
              </Button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
