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
  // `focus-visible` rather than `focus`: macOS does not ring a button you
  // clicked with the mouse, only one you reached with the keyboard. A ring on
  // click is the loudest "this is a web app" tell in the UI.
  const baseClasses =
    "inline-flex items-center justify-center font-medium rounded-full border focus:outline-none focus-visible:outline-none transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap";

  const variantClasses = {
    // `glimmer` sweeps a specular highlight across the primary CTA on hover —
    // the one button in the app important enough to react to the pointer.
    primary:
      "text-white bg-accent-deep border-transparent hover:bg-background-ui-hover btn-glow glimmer focus-visible:ring-2 focus-visible:ring-accent/40",
    "primary-soft":
      "text-accent-bright bg-accent/10 border-accent/25 hover:bg-accent/15 hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/30",
    secondary:
      "text-text bg-fill-1 border-hairline-strong hover:bg-fill-3 hover:border-hairline-strong focus-visible:ring-2 focus-visible:ring-accent/30",
    danger:
      "text-white bg-danger-solid border-transparent hover:brightness-110 focus-visible:ring-2 focus-visible:ring-danger/40",
    "danger-ghost":
      "text-danger bg-transparent border-transparent hover:bg-danger/10 focus-visible:bg-danger/15",
    ghost:
      "text-text-muted bg-transparent border-transparent hover:text-text hover:bg-fill-2 focus-visible:bg-fill-3",
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
