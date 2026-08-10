import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";

export interface StyleOption {
  id: string;
  title: string;
  subtitle: string;
  /** Sample rendering shown in the shared preview when this row is active. */
  sample: React.ReactNode;
  /** Optional pill after the title (e.g. "Default"). */
  badge?: React.ReactNode;
  /** Optional trailing control (e.g. "Edit" on the custom style). */
  action?: React.ReactNode;
  /** 0–3. Renders an ordinal strength meter for scales like Auto Cleanup. */
  intensity?: number;
}

interface StylePickerProps {
  ariaLabel: string;
  options: StyleOption[];
  value: string;
  onSelect: (id: string) => void;
}

/**
 * One choice out of a handful, each of which is best explained by showing the
 * same sentence written that way.
 *
 * The previous take put every option in its own card in a four-column grid.
 * Inside a 560px settings pane that left ~120px per card, so the sample text —
 * the whole reason the cards existed — wrapped to two words a line and the
 * cards ended up different heights. This inverts it: the options are a compact
 * radio list, and there is exactly one preview panel, full width, showing the
 * selected row (or whichever row the pointer is over, so styles can be
 * compared without committing to one).
 */
export const StylePicker: React.FC<StylePickerProps> = ({
  ariaLabel,
  options,
  value,
  onSelect,
}) => {
  const { t } = useTranslation();
  // Pointer/keyboard focus temporarily overrides which sample is on show.
  const [peeked, setPeeked] = useState<string | null>(null);

  const shown =
    options.find((o) => o.id === (peeked ?? value)) ??
    options.find((o) => o.id === value) ??
    options[0];

  return (
    <div className="rounded-xl border border-hairline-strong overflow-hidden">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="divide-y divide-[color:var(--color-hairline)]"
      >
        {options.map((o) => {
          const selected = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(o.id)}
              onMouseEnter={() => setPeeked(o.id)}
              onMouseLeave={() => setPeeked(null)}
              onFocus={() => setPeeked(o.id)}
              onBlur={() => setPeeked(null)}
              className={`group w-full flex items-center gap-3 px-3.5 py-2.5 text-start transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
                selected ? "bg-accent/[0.08]" : "hover:bg-fill-2"
              }`}
            >
              <span
                aria-hidden
                className={`relative shrink-0 w-[15px] h-[15px] rounded-full border transition-colors duration-150 ${
                  selected
                    ? "border-accent bg-accent"
                    : "border-hairline-strong group-hover:border-text-faint"
                }`}
              >
                {selected && (
                  <Check
                    className="absolute inset-0 m-auto w-2.5 h-2.5 text-white"
                    strokeWidth={3.5}
                  />
                )}
              </span>

              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{o.title}</span>
                  {o.badge}
                </span>
                <span className="block text-[12px] text-text-muted leading-snug mt-0.5">
                  {o.subtitle}
                </span>
              </span>

              {o.intensity !== undefined && (
                <IntensityMeter level={o.intensity} active={selected} />
              )}
              {o.action && <span className="shrink-0">{o.action}</span>}
            </button>
          );
        })}
      </div>

      <div className="border-t border-hairline-strong bg-fill-2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            {t("settings.style.preview.label")}
          </span>
          <span className="text-[11px] text-text-faint truncate">
            {shown?.title}
          </span>
        </div>
        {/* Every sample is laid into the same grid cell and all but one are
            hidden, so the panel is always as tall as the longest sample in the
            set. Swapping previews on hover can't make the page jump. */}
        <div className="grid mt-1.5 min-h-[44px]">
          {options.map((o) => (
            <p
              key={o.id}
              aria-hidden={o.id !== shown?.id}
              className={`col-start-1 row-start-1 text-[12.5px] leading-relaxed text-text/85 whitespace-pre-wrap ${
                o.id === shown?.id ? "" : "invisible"
              }`}
            >
              {o.sample}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
};

const IntensityMeter: React.FC<{ level: number; active: boolean }> = ({
  level,
  active,
}) => (
  <span aria-hidden className="flex items-end gap-[3px] shrink-0 h-3">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        style={{ height: `${6 + i * 3}px` }}
        className={`w-[3px] rounded-full transition-colors duration-150 ${
          i < level
            ? active
              ? "bg-accent"
              : "bg-text-muted/60"
            : "bg-[color:var(--color-hairline)]"
        }`}
      />
    ))}
  </span>
);
