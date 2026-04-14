import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

type Props = {
  title: string;
  load: () => Promise<string>;
  onClose: () => void;
};

/** Read-only in-app viewer for bundled legal text (EULA, third-party notices). */
export function LegalViewer({ title, load, onClose }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-6">
      <div className="w-full max-w-3xl h-[85vh] flex flex-col rounded-lg bg-background border border-mid-gray/20 shadow-2xl">
        <div className="px-6 py-4 flex items-center justify-between border-b border-mid-gray/20">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("settings.eula.viewerClose")}
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 bg-mid-gray/5">
          {error ? (
            <p className="text-red-400 text-sm">{error}</p>
          ) : text === null ? (
            <p className="text-sm text-mid-gray">…</p>
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
