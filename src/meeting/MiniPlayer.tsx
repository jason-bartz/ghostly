import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2 } from "lucide-react";

/**
 * The panel, minimised.
 *
 * Minimising a recording meeting to nothing is the failure this replaces: the
 * window went away, capture carried on, and the only remaining evidence was a
 * tray icon nobody looks at. What is left instead is the smallest thing that
 * still answers the question the panel was answering — *is this still on, and is
 * anyone talking?* — a waveform, a clock, and a dot.
 *
 * It is the same window and the same React tree; the panel underneath is only
 * hidden. That is what keeps a half-typed note, an unsaved title and the live
 * transcript intact across a minimise, and why clicking this is instant rather
 * than a second webview booting.
 *
 * Dragging and clicking share one gesture: past a few pixels of movement the
 * window takes over as a drag, and anything shorter is a click that restores the
 * panel. A pill this size is too small to spend part of on a separate handle.
 */

/** Bars in the waveform. Twenty at ~7 Hz is about three seconds of history. */
const BARS = 20;
/** Movement, in pixels, that turns a click into a drag. */
const DRAG_THRESHOLD = 3;

interface LevelPayload {
  /** Loudest microphone frame since the last sample, 0..1. */
  mic: number;
  /** Loudest system-audio frame since the last sample, 0..1. */
  system: number;
}

interface MiniPlayerProps {
  /** Capture is running — the waveform means something. */
  active: boolean;
  paused: boolean;
  /** Captured time, formatted, or null when there is no meeting to time. */
  clock: string | null;
  onRestore: () => void;
}

/**
 * Speech sits between roughly 0.01 and 0.15 mean amplitude, which drawn
 * linearly is a flat line with the occasional spike. The square root spends the
 * height where the differences actually are.
 */
function barHeight(level: number): number {
  const normalized = Math.min(1, Math.sqrt(level / 0.12));
  return 2 + normalized * 16;
}

export const MiniPlayer: React.FC<MiniPlayerProps> = ({
  active,
  paused,
  clock,
  onRestore,
}) => {
  const { t } = useTranslation();
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [hovered, setHovered] = useState(false);
  // Where the pointer went down, until it either moves far enough to be a drag
  // or comes back up as a click.
  const origin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const unlisten = listen<LevelPayload>("meeting-level", (event) => {
      // Whoever is louder. The waveform is the conversation, not one side of it
      // — for most of a meeting the person talking is not the user.
      const level = Math.max(event.payload.mic, event.payload.system);
      setLevels((previous) => [...previous.slice(1), level]);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // No levels arrive while capture is stopped or paused, so without this the
  // waveform would freeze mid-sentence and read as live audio.
  useEffect(() => {
    if (!active || paused) setLevels(Array(BARS).fill(0));
  }, [active, paused]);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    origin.current = { x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const start = origin.current;
    if (!start) return;
    const distance = Math.hypot(
      event.clientX - start.x,
      event.clientY - start.y,
    );
    if (distance < DRAG_THRESHOLD) return;
    // Handing the gesture to the window ends it as far as the page is
    // concerned, so clearing this is what stops the drag from also restoring.
    origin.current = null;
    void getCurrentWindow().startDragging();
  };

  const handlePointerUp = () => {
    const click = origin.current !== null;
    origin.current = null;
    if (click) onRestore();
  };

  // The clock gives way to the affordance under the cursor. Two things in one
  // 30pt slot, because a pill this size has room for exactly one of them.
  const showClock = clock !== null && !hovered;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("meeting.panel.restore")}
      title={t("meeting.panel.restoreHint")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => {
        origin.current = null;
        setHovered(false);
      }}
      onPointerEnter={() => setHovered(true)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onRestore();
      }}
      className="absolute inset-0 z-10 flex cursor-pointer select-none items-center gap-2 rounded-[20px] bg-surface-1 px-3 text-text transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
    >
      <span
        className={`h-[6px] w-[6px] shrink-0 rounded-full ${
          active && !paused
            ? "animate-pulse bg-danger"
            : active
              ? "bg-warning"
              : "bg-text-faint"
        }`}
        aria-hidden
      />

      {/* The waveform. Bars rather than a path: at twenty samples a line is
          mostly interpolation, and the point is only ever "someone is still
          talking", which a bar chart says at a glance and at any size. */}
      <div
        className="flex h-5 flex-1 items-center justify-between gap-[2px]"
        aria-hidden
      >
        {levels.map((level, index) => (
          <span
            key={index}
            style={{ height: `${barHeight(level)}px` }}
            className={`w-[2px] shrink-0 rounded-full transition-[height,background-color] duration-150 ${
              active && !paused ? "bg-accent" : "bg-text-faint/60"
            }`}
          />
        ))}
      </div>

      {showClock ? (
        <span className="shrink-0 text-[10px] font-medium tabular-nums text-text-muted">
          {clock}
        </span>
      ) : (
        <Maximize2 className="h-3 w-3 shrink-0 text-text-subtle" aria-hidden />
      )}
    </div>
  );
};

export default MiniPlayer;
