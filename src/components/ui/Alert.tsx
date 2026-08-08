import React from "react";
import { AlertCircle, AlertTriangle, Info, CheckCircle } from "lucide-react";

type AlertVariant = "error" | "warning" | "info" | "success";

interface AlertProps {
  variant?: AlertVariant;
  /** When true, removes rounded corners for use inside containers */
  contained?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Status tones come from the semantic `--color-{danger,warning,success}` tokens,
 * never the raw Tailwind palette. A fixed tint like Tailwind's `amber-200` is
 * tuned for a black canvas and turns into pale-yellow-on-white in light mode;
 * the tokens flip to their darker, readable counterparts when the theme does.
 */
const variantStyles: Record<
  AlertVariant,
  { container: string; icon: string; text: string }
> = {
  error: {
    container: "bg-danger/10 border border-danger/30",
    icon: "text-danger",
    text: "text-danger",
  },
  warning: {
    container: "bg-warning/10 border border-warning/30",
    icon: "text-warning",
    text: "text-warning",
  },
  info: {
    container: "bg-accent/10 border border-accent/25",
    icon: "text-accent-bright",
    text: "text-accent-bright",
  },
  success: {
    container: "bg-success/10 border border-success/30",
    icon: "text-success",
    text: "text-success",
  },
};

const variantIcons: Record<AlertVariant, React.ElementType> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
};

export const Alert: React.FC<AlertProps> = ({
  variant = "error",
  contained = false,
  children,
  className = "",
}) => {
  const styles = variantStyles[variant];
  const Icon = variantIcons[variant];

  return (
    <div
      className={`flex items-start gap-3 p-3.5 ${styles.container} ${contained ? "" : "rounded-xl"} ${className}`}
    >
      <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${styles.icon}`} />
      <p className={`text-[13px] leading-snug ${styles.text}`}>{children}</p>
    </div>
  );
};
