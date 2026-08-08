import React from "react";
import GhostlyMark from "./GhostlyMark";

/** Proper noun — the product name is never translated. */
const BRAND = "Ghostly";

/**
 * The Ghostly lockup: mark plus wordmark.
 *
 * Composed at runtime from the vector mark and live text rather than shipped
 * as artwork. The previous wordmark was a 292 kB base64 PNG in an `.svg`
 * wrapper — soft when scaled, and a fixed colour that could not follow the
 * light/dark themes. Setting it in the app's own typeface also means the logo
 * and the UI can never drift apart.
 *
 * `width` is the intended overall lockup width; type and mark scale from it.
 */
const GhostlyLogo = ({
  width = 130,
  className = "",
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  const fontSize = width * 0.2;
  // The mark reads optically small against caps at matched height, so it runs
  // a little taller than the type.
  const markHeight = fontSize * 1.2;

  return (
    <span
      className={`inline-flex items-center ${className}`}
      style={{ gap: fontSize * 0.3 }}
      aria-label="Ghostly"
      role="img"
    >
      <GhostlyMark height={markHeight} className="text-accent shrink-0" />
      <span
        className="font-semibold text-text leading-none"
        style={{ fontSize, letterSpacing: "-0.03em" }}
      >
        {BRAND}
      </span>
    </span>
  );
};

export default GhostlyLogo;
