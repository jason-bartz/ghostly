import React, { useState } from "react";
import { Input } from "../../ui/Input";

interface ApiKeyFieldProps {
  value: string;
  onBlur: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

export const ApiKeyField: React.FC<ApiKeyFieldProps> = React.memo(
  ({ value, onBlur, disabled, placeholder, className = "", ariaLabel }) => {
    const [localValue, setLocalValue] = useState(value);

    React.useEffect(() => {
      setLocalValue(value);
    }, [value]);

    return (
      <Input
        type="password"
        value={localValue}
        onChange={(event) => setLocalValue(event.target.value)}
        onBlur={() => onBlur(localValue)}
        placeholder={placeholder}
        variant="compact"
        disabled={disabled}
        className={`flex-1 min-w-[320px] ${className}`}
        aria-label={ariaLabel}
      />
    );
  },
);

ApiKeyField.displayName = "ApiKeyField";
