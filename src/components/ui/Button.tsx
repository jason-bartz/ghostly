import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "primary-soft"
    | "secondary"
    | "danger"
    | "danger-ghost"
    | "ghost";
  size?: "sm" | "md" | "lg";
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = "",
  variant = "primary",
  size = "md",
  ...props
}) => {
  const baseClasses =
    "inline-flex items-center justify-center font-medium rounded-full border focus:outline-none transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";

  const variantClasses = {
    primary:
      "text-white bg-accent-deep border-transparent hover:bg-background-ui-hover btn-glow focus:ring-2 focus:ring-accent/40",
    "primary-soft":
      "text-accent-bright bg-accent/10 border-accent/25 hover:bg-accent/15 hover:border-accent/40 focus:ring-2 focus:ring-accent/30",
    secondary:
      "text-text bg-white/[0.03] border-hairline-strong hover:bg-white/[0.06] hover:border-hairline-strong focus:ring-2 focus:ring-accent/30",
    danger:
      "text-white bg-red-500/90 border-transparent hover:bg-red-500 focus:ring-2 focus:ring-red-500/40",
    "danger-ghost":
      "text-red-400 bg-transparent border-transparent hover:text-red-300 hover:bg-red-500/10 focus:bg-red-500/15",
    ghost:
      "text-text-muted bg-transparent border-transparent hover:text-text hover:bg-white/[0.04] focus:bg-white/[0.06]",
  };

  const sizeClasses = {
    sm: "h-7 px-3 text-[11px]",
    md: "h-8 px-4 text-[12.5px]",
    lg: "h-9 px-5 text-sm",
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
