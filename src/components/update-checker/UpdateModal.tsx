import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useUpdaterStore } from "@/stores/updaterStore";
import { formatBytes, formatEta } from "@/lib/utils/format";
import { useFocusTrap } from "@/hooks/useFocusTrap";

export const UpdateModal: React.FC = () => {
  const { t } = useTranslation();
  const modalOpen = useUpdaterStore((s) => s.modalOpen);
  const status = useUpdaterStore((s) => s.status);
  const available = useUpdaterStore((s) => s.available);
  const progress = useUpdaterStore((s) => s.progress);
  const error = useUpdaterStore((s) => s.error);

  const downloadAndInstall = useUpdaterStore((s) => s.downloadAndInstall);
  const restartNow = useUpdaterStore((s) => s.restartNow);
  const remindLater = useUpdaterStore((s) => s.remindLater);
  const skipCurrent = useUpdaterStore((s) => s.skipCurrent);
  const closeModal = useUpdaterStore((s) => s.closeModal);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, modalOpen && !!available);

  const isDownloading = status === "downloading";
  const isReady = status === "ready";
  const isError = status === "error";

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDownloading) closeModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen, isDownloading, closeModal]);

  if (!modalOpen || !available) return null;

  const percent = Math.round(progress?.percent ?? 0);
  const notes = available.notes?.trim() ?? "";

  const onPrimaryClick = () => {
    if (isReady) {
      void restartNow();
    } else if (isError) {
      void downloadAndInstall();
    } else if (!isDownloading) {
      void downloadAndInstall();
    }
  };

  const primaryLabel = isReady
    ? t("updater.modal.restartButton")
    : isError
      ? t("updater.modal.errorRetry")
      : isDownloading
        ? t("updater.modal.installing")
        : t("updater.modal.installButton");

  // Only allow dismiss via backdrop when not installing.
  const allowDismiss = !isDownloading;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={() => allowDismiss && closeModal()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        className="surface-card-inlay !rounded-2xl max-w-lg w-full mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span className="tag-pill mb-3">Ghostly</span>
          <h2
            id="update-modal-title"
            className="text-xl font-display tracking-tight text-text mt-2"
          >
            {t("updater.modal.title")}
          </h2>
          <p className="text-xs text-text-faint mt-1 tabular-nums">
            {t("updater.modal.subtitle", {
              current: available.currentVersion,
              next: available.version,
            })}
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-[0.08em]">
            {t("updater.modal.notesHeading")}
          </h3>
          <div className="max-h-64 overflow-y-auto rounded-lg border border-hairline bg-surface-1/40 px-3 py-2">
            {notes ? (
              <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-text font-sans">
                {notes}
              </pre>
            ) : (
              <p className="text-[13px] text-text-muted italic">
                {t("updater.modal.notesEmpty")}
              </p>
            )}
          </div>
        </div>

        {isDownloading && (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full rounded-full bg-surface-1 overflow-hidden">
              <div
                className="h-full bg-accent-bright transition-[width] duration-150"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-xs text-text-muted tabular-nums">
              <span>
                {progress && progress.total
                  ? t("updater.modal.progressBytes", {
                      done: formatBytes(progress.downloaded),
                      total: formatBytes(progress.total),
                    })
                  : progress
                    ? formatBytes(progress.downloaded)
                    : ""}
              </span>
              <span>
                {progress && progress.speedBytesPerSec > 0
                  ? t("updater.modal.speedAndEta", {
                      speed: (progress.speedBytesPerSec / (1024 * 1024)).toFixed(1),
                      eta: formatEta(progress.etaSeconds),
                    })
                  : t("updater.modal.progress", { percent })}
              </span>
            </div>
          </div>
        )}

        {isError && error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
            <p className="text-[11px] font-semibold text-red-400 uppercase tracking-[0.08em] mb-1">
              {t("updater.modal.errorTitle")}
            </p>
            <p className="text-[13px] text-text-muted leading-relaxed break-words">
              {error}
            </p>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2 flex-wrap">
          {!isDownloading && !isReady && (
            <>
              <button
                className="px-3.5 py-1.5 text-xs font-medium rounded-full text-text-muted hover:text-text hover:bg-white/[0.04] transition-colors"
                onClick={skipCurrent}
              >
                {t("updater.modal.skipButton")}
              </button>
              <button
                className="px-3.5 py-1.5 text-xs font-medium rounded-full border border-hairline-strong text-text hover:bg-white/[0.04] transition-colors"
                onClick={remindLater}
              >
                {t("updater.modal.laterButton")}
              </button>
            </>
          )}
          <button
            disabled={isDownloading}
            className="px-4 py-1.5 text-xs font-medium rounded-full bg-accent-deep hover:bg-background-ui-hover disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors btn-glow"
            onClick={onPrimaryClick}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
