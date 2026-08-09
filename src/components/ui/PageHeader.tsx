import React from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Right-aligned controls — a view switcher, a primary action. */
  actions?: React.ReactNode;
}

/**
 * The title block every settings destination starts with.
 *
 * Previously only Notes and Health had one, and each rolled its own markup, so
 * moving between tabs shifted the heading position and changed the type scale.
 * Sections without a header started straight into a card, which read as a
 * different app.
 *
 * `items-end` keeps the actions baseline-aligned with the title rather than
 * floating above a two-line description.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
}) => (
  <div className="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-xl font-semibold leading-none tracking-tight">
        {title}
      </h1>
      {description && (
        <p className="mt-1.5 text-[12.5px] leading-snug text-text-muted">
          {description}
        </p>
      )}
    </div>
    {actions}
  </div>
);
