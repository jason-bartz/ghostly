import React from "react";
import { useTranslation } from "react-i18next";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { Appearance } from "@/bindings";
import { useAppearance } from "@/hooks/useAppearance";

const OPTIONS: {
  value: Appearance;
  labelKey: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "dark", labelKey: "settings.appearance.dark", Icon: Moon },
  { value: "light", labelKey: "settings.appearance.light", Icon: Sun },
  { value: "system", labelKey: "settings.appearance.system", Icon: Monitor },
];

/**
 * Miniature of the app's own chrome — sidebar rail, header line, two content
 * rows. Rendered with literal colours rather than tokens on purpose: each
 * swatch has to show the theme it *represents*, not the theme currently
 * active, so a user on dark can see what light looks like before committing.
 */
const ThemePreview: React.FC<{ variant: "dark" | "light" | "split" }> = ({
  variant,
}) => {
  const dark = { bg: "#0b0b12", rail: "#17171f", line: "#2c2a3a" };
  const light = { bg: "#faf9fd", rail: "#efedf6", line: "#d9d5e6" };

  const Panel: React.FC<{ c: typeof dark; className?: string }> = ({
    c,
    className = "",
  }) => (
    <div
      className={`absolute inset-0 flex ${className}`}
      style={{ background: c.bg }}
    >
      <div className="w-1/4 h-full" style={{ background: c.rail }} />
      <div className="flex-1 p-1.5 flex flex-col gap-1 justify-center">
        <div
          className="h-1 w-3/4 rounded-full"
          style={{ background: "#7c3aed" }}
        />
        <div
          className="h-1 w-full rounded-full"
          style={{ background: c.line }}
        />
        <div
          className="h-1 w-1/2 rounded-full"
          style={{ background: c.line }}
        />
      </div>
    </div>
  );

  return (
    <div className="relative w-full h-11 rounded-lg overflow-hidden border border-hairline">
      {variant === "light" ? (
        <Panel c={light} />
      ) : variant === "dark" ? (
        <Panel c={dark} />
      ) : (
        <>
          <Panel c={dark} />
          {/* Diagonal reveal — reads as "whichever the system says". */}
          <div
            className="absolute inset-0"
            style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
          >
            <Panel c={light} />
          </div>
        </>
      )}
    </div>
  );
};

export const AppearanceSelector: React.FC = () => {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useAppearance();

  return (
    <div className="px-4 py-3.5">
      <h3 className="text-sm font-medium mb-0.5">
        {t("settings.appearance.title")}
      </h3>
      <p className="text-[12.5px] text-text-muted leading-snug mb-3">
        {t("settings.appearance.description")}
      </p>

      <div
        role="radiogroup"
        aria-label={t("settings.appearance.title")}
        className="grid grid-cols-3 gap-2.5"
      >
        {OPTIONS.map(({ value, labelKey, Icon }) => {
          const active = appearance === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setAppearance(value)}
              className={`group relative rounded-xl p-2 text-left transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                active
                  ? "bg-accent/[0.08] ring-1 ring-accent/50"
                  : "bg-fill-1 ring-1 ring-transparent hover:bg-fill-2 hover:ring-hairline-strong"
              }`}
            >
              <ThemePreview
                variant={
                  value === "system"
                    ? "split"
                    : (value as unknown as "dark" | "light")
                }
              />
              <div className="flex items-center gap-1.5 mt-2 px-0.5">
                <Icon
                  className={`w-3 h-3 shrink-0 ${
                    active ? "text-accent-bright" : "text-text-faint"
                  }`}
                />
                <span
                  className={`text-[11.5px] font-medium truncate ${
                    active ? "text-text" : "text-text-muted"
                  }`}
                >
                  {t(labelKey)}
                </span>
                {active && (
                  <Check
                    className="w-3 h-3 ms-auto shrink-0 text-accent-bright"
                    strokeWidth={3}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
