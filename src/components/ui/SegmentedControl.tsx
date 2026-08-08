import React, { useLayoutEffect, useRef, useState } from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  Icon?: React.ComponentType<{ className?: string }>;
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * iOS-style segmented control with a sliding glass thumb.
 *
 * The thumb is a single absolutely-positioned element measured from the active
 * segment rather than a per-segment background. That's what lets it *travel*
 * between options instead of blinking from one to the next — the motion is the
 * whole reason to use this over a row of buttons.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = "md",
  className = "",
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(
    null,
  );

  // Measure after layout so the thumb is correct on first paint (no flash from
  // 0,0) and stays correct when labels change with the app language.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const active = container.querySelector<HTMLElement>(
        '[data-active="true"]',
      );
      if (!active) return;
      setThumb({ left: active.offsetLeft, width: active.offsetWidth });
    };

    measure();
    // Font loading and window resizes both shift segment widths.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [value, options]);

  const pad = size === "sm" ? "p-0.5" : "p-1";
  const seg =
    size === "sm"
      ? "h-6 px-2 text-[11px] gap-1"
      : "h-7 px-2.5 text-[12px] gap-1.5";

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`relative inline-flex items-center rounded-lg bg-fill-1 border border-hairline ${pad} ${className}`}
    >
      {thumb && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 rounded-[7px] glass transition-[left,width] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}

      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.Icon;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active}
            title={option.title ?? option.label}
            onClick={() => onChange(option.value)}
            className={`relative z-10 inline-flex items-center justify-center rounded-[7px] font-medium whitespace-nowrap cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${seg} ${
              active ? "text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
