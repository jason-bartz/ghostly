import React from "react";

/* =============================================================================
 * Shared tour parts
 *
 * Small pieces used by more than one step. Kept together so the steps stay
 * about *what they teach* rather than about markup.
 * ========================================================================== */

/** macOS glyphs for modifiers. Non-JSX so the i18n lint rule (which polices
 *  literal strings in markup) doesn't have to be suppressed at every call. */
const KEY_GLYPHS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  enter: "↵",
  return: "↵",
  escape: "esc",
  esc: "esc",
  tab: "⇥",
  space: "Space",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/**
 * Turn a stored binding ("cmd+option+s", "fn") into display tokens.
 *
 * Left/right variants collapse to the base modifier: nobody thinks of their
 * shortcut as "Left Option", and the distinction is meaningless on a keycap.
 */
export function keyTokens(binding: string): string[] {
  if (!binding) return [];
  return binding
    .split("+")
    .map((raw) => {
      const key = raw
        .trim()
        .toLowerCase()
        .replace(/_(left|right)$/, "");
      if (!key) return "";
      if (KEY_GLYPHS[key]) return KEY_GLYPHS[key];
      if (key === "fn") return "fn";
      if (/^f\d+$/.test(key)) return key.toUpperCase();
      if (key.length === 1) return key.toUpperCase();
      return key.replace(/\b\w/g, (c) => c.toUpperCase());
    })
    .filter(Boolean);
}

interface KeyComboProps {
  binding: string;
  size?: "sm" | "lg";
  pressed?: boolean;
  className?: string;
}

/** A binding rendered as physical keycaps. */
export const KeyCombo: React.FC<KeyComboProps> = ({
  binding,
  size = "sm",
  pressed = false,
  className = "",
}) => {
  const tokens = keyTokens(binding);
  if (tokens.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {tokens.map((token, i) => (
        <kbd
          key={`${token}-${i}`}
          data-pressed={pressed}
          className={`tour-keycap ${size === "lg" ? "tour-keycap-lg" : ""}`}
        >
          {token}
        </kbd>
      ))}
    </span>
  );
};

interface StepHeaderProps {
  eyebrow?: string;
  title: string;
  body?: string;
  /** Stagger index, so a header can sit anywhere in a step's sequence. */
  index?: number;
  align?: "center" | "start";
}

export const StepHeader: React.FC<StepHeaderProps> = ({
  eyebrow,
  title,
  body,
  index = 0,
  align = "center",
}) => (
  <div
    data-rise
    style={{ "--i": index } as React.CSSProperties}
    className={`flex flex-col gap-2 ${
      align === "center" ? "items-center text-center" : "items-start text-start"
    }`}
  >
    {eyebrow && <span className="tag-pill">{eyebrow}</span>}
    <h2 className="text-[25px] leading-[1.15] font-display tracking-tight text-text">
      {title}
    </h2>
    {body && (
      <p className="text-[13.5px] leading-relaxed text-text-muted max-w-[30rem]">
        {body}
      </p>
    )}
  </div>
);

/** A check that draws itself. Used wherever a step resolves successfully. */
export const SuccessCheck: React.FC<{ size?: number }> = ({ size = 56 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    fill="none"
    role="presentation"
    className="tour-check-ring"
  >
    <circle
      cx="16"
      cy="16"
      r="15"
      fill="color-mix(in srgb, var(--color-success) 14%, transparent)"
      stroke="color-mix(in srgb, var(--color-success) 45%, transparent)"
      strokeWidth="1"
    />
    <path
      className="tour-check-path"
      d="M10 16.4 L14.3 20.6 L22.2 12"
      stroke="var(--color-success)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

interface WaveformProps {
  /** Latest `mic-level` frame. Empty means "armed but silent". */
  levels: number[];
  bars?: number;
  height?: number;
  className?: string;
}

/**
 * Live input meter.
 *
 * Bars are positioned from the centre outward so loud speech blooms from the
 * middle rather than sweeping in from one edge — the same read as the
 * recording overlay, which is where users will next see this shape.
 */
export const Waveform: React.FC<WaveformProps> = ({
  levels,
  bars = 21,
  height = 44,
  className = "",
}) => {
  const idle = levels.length === 0;
  const mid = (bars - 1) / 2;

  return (
    <div
      className={`flex items-center justify-center gap-[3px] ${className}`}
      style={{ height }}
      aria-hidden
    >
      {Array.from({ length: bars }, (_, i) => {
        // Map bar position onto the level buffer, mirrored around the centre.
        const distance = Math.abs(i - mid) / mid;
        const source = levels.length
          ? levels[Math.floor(distance * (levels.length - 1))]
          : 0;
        // Taper the edges so the meter has a shape even at constant volume.
        const falloff = 1 - distance * 0.55;
        const level = Math.max(0.06, Math.min(1, source * falloff * 1.6));
        return (
          <span
            key={i}
            data-idle={idle}
            className="tour-bar"
            style={
              {
                height: "100%",
                "--level": level,
                "--i": Math.round(distance * 10),
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
};
