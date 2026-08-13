import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The close / minimise / zoom buttons, drawn rather than inherited.
 *
 * The panel is an undecorated, transparent `NSPanel` — that is what lets it
 * float over a full-screen call, follow the user between Spaces and keep its
 * rounded shape — and an undecorated window has no title bar for AppKit to put
 * its buttons in. Turning decorations back on to get them would cost every one
 * of those properties.
 *
 * It would also get the wrong behaviour. A panel cannot miniaturise to the Dock,
 * and it should not: a meeting that is still recording with nothing on screen
 * saying so is the one state this window exists to prevent. The yellow button
 * shrinks the panel to the mini player instead, which is not something the
 * system button could have been asked to do.
 *
 * So these are hand-drawn to the system's measurements — 12pt circles, 8pt
 * apart, system colours, glyphs on hover of the group, grey while the window is
 * not key — and hovering an inactive window still lights them up, exactly as
 * AppKit does.
 */

interface TrafficLightsProps {
  onClose: () => void;
  onMinimize: () => void;
  onZoom: () => void;
}

interface LightProps {
  color: string;
  lit: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

const Light: React.FC<LightProps> = ({
  color,
  lit,
  label,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    style={lit ? { backgroundColor: color } : undefined}
    // The inset ring is the hairline AppKit draws around each button; without
    // it a yellow dot on a light title bar has no edge at all.
    className={`flex h-3 w-3 items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.12)] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
      lit ? "" : "bg-text-faint/40"
    }`}
  >
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      className="h-3 w-3 opacity-0 transition-opacity duration-100 group-hover/lights:opacity-100"
      fill="none"
      stroke="rgba(0,0,0,0.62)"
      strokeWidth="1.35"
      strokeLinecap="round"
    >
      {children}
    </svg>
  </button>
);

export const TrafficLights: React.FC<TrafficLightsProps> = ({
  onClose,
  onMinimize,
  onZoom,
}) => {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  // The panel deliberately appears without taking focus, so it spends most of a
  // meeting as a background window — which is exactly when its buttons should
  // be grey. Following the real focus state is what keeps it looking like a
  // window rather than a widget.
  useEffect(() => {
    const window = getCurrentWindow();
    void window.isFocused().then(setFocused);
    const unlisten = window.onFocusChanged(({ payload }) =>
      setFocused(payload),
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const lit = focused || hovered;

  return (
    <div
      className="group/lights flex shrink-0 items-center gap-2"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Light
        color="#FF5F57"
        lit={lit}
        label={t("meeting.panel.close")}
        onClick={onClose}
      >
        <path d="M4.1 4.1 L7.9 7.9 M7.9 4.1 L4.1 7.9" />
      </Light>

      <Light
        color="#FEBC2E"
        lit={lit}
        label={t("meeting.panel.minimize")}
        onClick={onMinimize}
      >
        <path d="M3.4 6 L8.6 6" />
      </Light>

      <Light
        color="#28C840"
        lit={lit}
        label={t("meeting.panel.zoom")}
        onClick={onZoom}
      >
        {/* The two opposed triangles the system draws on the green button.
            Kept small and pushed into the corners: any bigger and the diagonal
            gap closes up at 12pt, and the glyph reads as a slashed square. */}
        <path
          d="M3.4 3.4 L6.2 3.4 L3.4 6.2 Z M8.6 8.6 L5.8 8.6 L8.6 5.8 Z"
          fill="rgba(0,0,0,0.62)"
          stroke="none"
        />
      </Light>
    </div>
  );
};

export default TrafficLights;
