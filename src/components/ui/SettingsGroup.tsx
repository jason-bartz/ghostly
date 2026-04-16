import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  /** "band" (default) wraps the card in a landing-style gray band.
   *  "accent" uses the violet-tinted band for featured groups.
   *  "flat" renders the card alone (legacy look). */
  variant?: "band" | "accent" | "flat";
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
  variant = "band",
}) => {
  const bandClass =
    variant === "accent"
      ? "section-band-accent"
      : variant === "flat"
        ? ""
        : "section-band";

  const cardClass =
    variant === "flat" ? "surface-card" : "surface-card-inlay";

  return (
    <div className={variant === "flat" ? "space-y-2" : bandClass}>
      {title && (
        <div className={variant === "flat" ? "px-4" : "px-1 pb-3"}>
          <h2 className="text-[11px] font-semibold text-text-muted uppercase tracking-[0.08em]">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-text-muted mt-1">{description}</p>
          )}
        </div>
      )}
      <div className={`${cardClass} overflow-visible`}>
        <div className="divide-y divide-[color:var(--color-hairline)]">
          {children}
        </div>
      </div>
    </div>
  );
};
