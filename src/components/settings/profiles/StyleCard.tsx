import React from "react";
import { Check } from "lucide-react";

interface StyleCardProps {
  title: string;
  subtitle: string;
  sample: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  /** Optional right-aligned action (e.g. "Edit" for a custom style card). */
  action?: React.ReactNode;
}

export const StyleCard: React.FC<StyleCardProps> = ({
  title,
  subtitle,
  sample,
  selected,
  onSelect,
  action,
}) => {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative flex flex-col text-left w-full rounded-xl border-2 p-4 transition-all duration-150 cursor-pointer
        ${
          selected
            ? "border-logo-primary bg-logo-primary/5 shadow-sm"
            : "border-mid-gray/20 bg-mid-gray/5 hover:border-mid-gray/40 hover:bg-mid-gray/10"
        }`}
      aria-pressed={selected}
    >
      {selected && (
        <span className="absolute top-3 right-3 flex items-center justify-center w-5 h-5 rounded-full bg-logo-primary text-white">
          <Check className="w-3.5 h-3.5" strokeWidth={3} />
        </span>
      )}
      <div className="flex items-start justify-between gap-2 pr-6">
        <div>
          <div className="text-base font-semibold">{title}</div>
          <div className="text-xs text-text/60 mt-0.5">{subtitle}</div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className="mt-3 rounded-lg bg-background/60 border border-mid-gray/15 px-3 py-2.5 text-xs text-text/80 whitespace-pre-wrap leading-relaxed min-h-[84px]">
        {sample}
      </div>
    </button>
  );
};
