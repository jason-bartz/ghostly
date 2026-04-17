import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CancelIcon } from "../components/icons";
import "./RecordingOverlay.css";
import { commands } from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import logoSrc from "@/assets/Ghostly-logo.svg";

type OverlayState = "recording" | "transcribing" | "processing" | "staged";

type StagedPayload = {
  thumbnail: string;
  text: string;
  confirmShortcut: string;
};

type EditChip = {
  id: string;
  label: string;
  instruction: string;
};

function formatKeystroke(ks: string): string {
  return ks
    .split("+")
    .map((t) => {
      const s = t.trim().toLowerCase();
      if (s === "enter" || s === "return") return "↵";
      if (s === "escape" || s === "esc") return "⎋";
      if (s === "tab") return "⇥";
      if (s === "shift") return "⇧";
      if (s === "cmd" || s === "meta") return "⌘";
      if (s === "ctrl" || s === "control") return "⌃";
      if (s === "alt" || s === "option") return "⌥";
      return t;
    })
    .join("");
}

const GhostIcon: React.FC = () => (
  <img src={logoSrc} width="22" height="22" className="ghost-icon" alt="" />
);

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const [levels, setLevels] = useState<number[]>(Array(14).fill(0));
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const [peakLevel, setPeakLevel] = useState<number>(0);
  const [staged, setStaged] = useState<StagedPayload | null>(null);
  const [editChips, setEditChips] = useState<EditChip[] | null>(null);
  const [pendingChipId, setPendingChipId] = useState<string | null>(null);
  const direction = getLanguageDirection(i18n.language);

  useEffect(() => {
    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        // Sync language from settings each time overlay is shown
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        setIsVisible(true);
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        // Clear staged + edit chips after hide animation
        setTimeout(() => {
          setStaged(null);
          setEditChips(null);
          setPendingChipId(null);
        }, 300);
      });

      // Listen for mic-level updates
      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];

        // Apply smoothing to reduce jitter
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3; // Smooth transition
        });

        smoothedLevelsRef.current = smoothed;
        const sliced = smoothed.slice(0, 14);
        // Arrange peak-in-middle: largest values center, smallest at edges
        const sorted = [...sliced].sort((a, b) => a - b);
        const mirrored: number[] = new Array(sliced.length);
        for (let i = 0; i < sliced.length; i++) {
          const center = (sliced.length - 1) / 2;
          const dist = Math.abs(i - center);
          const rank = sliced.length - 1 - Math.round(dist * 2);
          mirrored[i] = sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
        }
        setLevels(mirrored);
        setPeakLevel(Math.max(...sliced));
      });

      // Staged screenshot capture: show thumbnail + transcription + confirm hint
      const unlistenStaged = await listen<StagedPayload>(
        "staged-capture",
        (event) => {
          setStaged(event.payload);
        },
      );

      // Edit-mode chips appear when the user triggers the edit shortcut.
      // Speaking an instruction falls through to the voice-edit pipeline;
      // clicking a chip runs `apply_edit_chip` against the focused field.
      const unlistenEditMode = await listen<EditChip[]>(
        "edit-mode",
        (event) => {
          setEditChips(event.payload);
          setPendingChipId(null);
        },
      );

      // Chip action finished — Rust will also drive hide-overlay, but we
      // clear the pending state here so the UI doesn't stay stuck if timing
      // gets weird.
      const unlistenEditDone = await listen("edit-chip-done", () => {
        setPendingChipId(null);
        setEditChips(null);
      });

      // Cleanup function
      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenStaged();
        unlistenEditMode();
        unlistenEditDone();
      };
    };

    setupEventListeners();
  }, []);

  const getIcon = () => <GhostIcon />;

  const glowIntensity =
    state === "recording" ? Math.min(1, peakLevel * 1.5) : 0;

  if (state === "staged" && staged) {
    const formattedShortcut = staged.confirmShortcut
      ? formatKeystroke(staged.confirmShortcut)
      : null;
    const stagedPreview =
      staged.text.length > 80 ? staged.text.slice(0, 78) + "…" : staged.text;
    return (
      <div
        dir={direction}
        className={`recording-overlay staged-overlay ${isVisible ? "fade-in" : ""}`}
      >
        <div className="staged-top">
          <img src={staged.thumbnail} className="staged-thumb" alt="" />
          <div className="staged-text-block">
            <div className="staged-label">{t("overlay.stagedTitle")}</div>
            <div className="staged-text" title={staged.text}>
              {stagedPreview || t("overlay.stagedNoText")}
            </div>
          </div>
          <div
            className="cancel-button"
            onClick={() => {
              commands.cancelStagedCapture();
            }}
            title={t("overlay.stagedCancel")}
          >
            <CancelIcon />
          </div>
        </div>
        <div className="staged-hint">
          {formattedShortcut ? (
            <>
              {t("overlay.stagedPressToPaste")}{" "}
              <span className="staged-hint-key">{formattedShortcut}</span>
            </>
          ) : (
            t("overlay.stagedUnboundHint")
          )}
        </div>
      </div>
    );
  }

  const showingEditChips = state === "recording" && !!editChips;

  return (
    <div
      dir={direction}
      className={`recording-overlay ${showingEditChips ? "recording-overlay-wide" : ""} ${isVisible ? "fade-in" : ""}`}
      style={{
        boxShadow: `0 0 ${20 + glowIntensity * 18}px rgba(124, 58, 237, ${0.18 + glowIntensity * 0.35}), 0 4px 24px #00000080`,
      }}
    >
      <div className="overlay-left">{getIcon()}</div>

      <div className="overlay-middle">
        {state === "recording" && editChips && (
          <div className="edit-chips state-fade">
            {editChips.map((chip) => {
              const isPending = pendingChipId === chip.id;
              const disabled = pendingChipId !== null && !isPending;
              return (
                <button
                  key={chip.id}
                  type="button"
                  className={`edit-chip${isPending ? " edit-chip-pending" : ""}`}
                  disabled={disabled}
                  title={chip.instruction}
                  onClick={() => {
                    if (pendingChipId) return;
                    setPendingChipId(chip.id);
                    commands.applyEditChip(chip.id).catch(() => {
                      setPendingChipId(null);
                    });
                  }}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        )}
        {state === "recording" && !editChips && (
          <div className="bars-container state-fade">
            {levels.map((v, i) => (
              <div
                key={i}
                className="bar"
                style={{
                  height: `${Math.min(28, 3 + Math.pow(v, 0.65) * 25)}px`,
                  transition: "height 55ms ease-out, opacity 100ms ease-out",
                  opacity: Math.max(0.35, Math.min(1, v * 2)),
                }}
              />
            ))}
          </div>
        )}
        {state === "transcribing" && (
          <div className="transcribing-text state-fade">
            {t("overlay.transcribing")}
          </div>
        )}
        {state === "processing" && (
          <div className="transcribing-text state-fade">
            {t("overlay.processing")}
          </div>
        )}
      </div>

      <div className="overlay-right">
        {state === "recording" && (
          <div
            className="cancel-button"
            onClick={() => {
              commands.cancelOperation();
            }}
          >
            <CancelIcon />
          </div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
