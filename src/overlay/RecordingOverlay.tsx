import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TranscriptionIcon, CancelIcon } from "../components/icons";
import "./RecordingOverlay.css";
import { commands } from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import { getLanguageDirection } from "@/lib/utils/rtl";
import logoSrc from "@/assets/ghostly_logo.svg";

type OverlayState = "recording" | "transcribing" | "processing";

type IdeHint = {
  id: string;
  name: string;
  autoSubmit: boolean;
  commands: Array<{
    phrase: string;
    aliases: string[];
    keystroke: string;
    description: string;
  }>;
};

const HINT_DURATION_MS = 4500;

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
  const [previewText, setPreviewText] = useState<string>("");
  const [hint, setHint] = useState<IdeHint | null>(null);
  const hintTimerRef = useRef<number | null>(null);
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
        // Clear preview text when entering recording state
        if (overlayState === "recording") {
          setPreviewText("");
        }
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        // Clear preview after hide animation
        setTimeout(() => setPreviewText(""), 300);
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

      // Listen for transcription preview from Rust (shows text before paste)
      const unlistenPreview = await listen<string>(
        "transcription-preview",
        (event) => {
          setPreviewText(event.payload);
        },
      );

      // One-time IDE hint: show for a few seconds, then mark as seen so it
      // doesn't appear again for this preset.
      const unlistenHint = await listen<IdeHint>("ide-hint", (event) => {
        const payload = event.payload;
        setHint(payload);
        if (hintTimerRef.current) {
          window.clearTimeout(hintTimerRef.current);
        }
        hintTimerRef.current = window.setTimeout(() => {
          setHint(null);
        }, HINT_DURATION_MS);
        commands.markIdeHintSeen(payload.id).catch(() => {
          // Non-fatal: worst case the hint shows again next session.
        });
      });

      // Cleanup function
      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenPreview();
        unlistenHint();
      };
    };

    setupEventListeners();
  }, []);

  const getIcon = () => {
    if (state === "recording") {
      return <GhostIcon />;
    } else {
      return <TranscriptionIcon />;
    }
  };

  // Truncate preview text to fit the overlay width
  const truncatedPreview =
    previewText.length > 40 ? previewText.slice(0, 38) + "…" : previewText;

  const glowIntensity =
    state === "recording" ? Math.min(1, peakLevel * 1.5) : 0;

  return (
    <div
      dir={direction}
      className={`recording-overlay ${isVisible ? "fade-in" : ""}`}
      style={{
        boxShadow: `0 0 ${20 + glowIntensity * 18}px rgba(124, 58, 237, ${0.18 + glowIntensity * 0.35}), 0 4px 24px #00000080`,
      }}
    >
      <div className="overlay-left">{getIcon()}</div>

      <div className="overlay-middle">
        {state === "recording" && hint && (
          <div
            className="ide-hint state-fade"
            title={`${hint.name} voice commands`}
          >
            <span className="ide-hint-name">{hint.name}</span>
            <span className="ide-hint-sep">·</span>
            {hint.commands.slice(0, 2).map((c, i) => (
              <React.Fragment key={c.phrase}>
                {i > 0 && <span className="ide-hint-dot"> / </span>}
                <span className="ide-hint-phrase">"{c.phrase}"</span>
                <span className="ide-hint-key">
                  {formatKeystroke(c.keystroke)}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}
        {state === "recording" && !hint && (
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
            {previewText ? truncatedPreview : t("overlay.transcribing")}
          </div>
        )}
        {state === "processing" && (
          <div className="transcribing-text state-fade">
            {previewText ? truncatedPreview : t("overlay.processing")}
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
