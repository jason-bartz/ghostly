import React from "react";

interface SectionLabelProps {
  children: React.ReactNode;
  /** Optional one-line explanation under the label. */
  hint?: string;
}

/**
 * The same small caps heading `SettingsGroup` puts above a card, for sections
 * that live inside a panel and so can't use `SettingsGroup` itself.
 */
export const SectionLabel: React.FC<SectionLabelProps> = ({
  children,
  hint,
}) => (
  <div className="px-1 pb-2">
    <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-[0.08em]">
      {children}
    </h4>
    {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
  </div>
);
