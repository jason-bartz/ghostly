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

      // Cleanup function
      return () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
        unlistenPreview();
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
    previewText.length > 40
      ? previewText.slice(0, 38) + "…"
      : previewText;

  const glowIntensity = state === "recording" ? Math.min(1, peakLevel * 1.5) : 0;

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
        {state === "recording" && (
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
            {previewText
              ? truncatedPreview
              : t("overlay.transcribing")}
          </div>
        )}
        {state === "processing" && (
          <div className="transcribing-text state-fade">
            {previewText
              ? truncatedPreview
              : t("overlay.processing")}
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
