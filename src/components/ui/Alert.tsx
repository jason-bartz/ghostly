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

const variantStyles: Record<
  AlertVariant,
  { container: string; icon: string; text: string }
> = {
  error: {
    container: "bg-red-500/10 border border-red-500/25",
    icon: "text-red-400",
    text: "text-red-300",
  },
  warning: {
    container: "bg-amber-500/10 border border-amber-500/25",
    icon: "text-amber-400",
    text: "text-amber-200",
  },
  info: {
    container: "bg-accent/10 border border-accent/25",
    icon: "text-accent-bright",
    text: "text-accent-bright",
  },
  success: {
    container: "bg-emerald-500/10 border border-emerald-500/25",
    icon: "text-emerald-400",
    text: "text-emerald-300",
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
