import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: "default" | "compact";
}

export const Input: React.FC<InputProps> = ({
  className = "",
  variant = "default",
  disabled,
  ...props
}) => {
  const baseClasses =
    "text-sm font-medium bg-white/[0.03] border border-hairline-strong rounded-lg text-text text-start transition-all duration-150 placeholder:text-text-faint";

  const interactiveClasses = disabled
    ? "opacity-60 cursor-not-allowed"
    : "hover:border-accent/40 hover:bg-white/[0.05] focus:outline-none focus:border-accent focus:bg-white/[0.06] focus:ring-2 focus:ring-accent/20";

  const variantClasses = {
    default: "h-8 px-3 py-1.5",
    compact: "h-7 px-2 py-1",
  } as const;

  return (
    <input
      className={`${baseClasses} ${variantClasses[variant]} ${interactiveClasses} ${className}`}
      disabled={disabled}
      {...props}
    />
  );
};
