import React, { useState } from "react";
import { Input } from "../../ui/Input";

interface BaseUrlFieldProps {
  value: string;
  onBlur: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

export const BaseUrlField: React.FC<BaseUrlFieldProps> = React.memo(
  ({ value, onBlur, disabled, placeholder, className = "", ariaLabel }) => {
    const [localValue, setLocalValue] = useState(value);

    React.useEffect(() => {
      setLocalValue(value);
    }, [value]);

    const disabledMessage = disabled
      ? "Base URL is managed by the selected provider."
      : undefined;

    return (
      <Input
        type="text"
        value={localValue}
        onChange={(event) => setLocalValue(event.target.value)}
        onBlur={() => onBlur(localValue)}
        placeholder={placeholder}
        variant="compact"
        disabled={disabled}
        className={`flex-1 min-w-[360px] ${className}`}
        title={disabledMessage}
        aria-label={ariaLabel}
      />
    );
  },
);

BaseUrlField.displayName = "BaseUrlField";
