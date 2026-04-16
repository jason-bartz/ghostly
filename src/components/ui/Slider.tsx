import React from "react";
import { SettingContainer } from "./SettingContainer";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  label: string;
  description: string;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  showValue?: boolean;
  formatValue?: (value: number) => string;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  disabled = false,
  label,
  description,
  descriptionMode = "tooltip",
  grouped = false,
  showValue = true,
  formatValue = (v) => v.toFixed(2),
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(e.target.value));
  };

  return (
    <SettingContainer
      title={label}
      description={description}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
      disabled={disabled}
    >
      <div className="w-full">
        <div className="flex items-center space-x-1 h-6">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={handleChange}
            disabled={disabled}
            className="flex-grow h-1.5 rounded-full appearance-none cursor-pointer focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent-deep) ${
                ((value - min) / (max - min)) * 100
              }%, rgba(255, 255, 255, 0.08) ${
                ((value - min) / (max - min)) * 100
              }%, rgba(255, 255, 255, 0.08) 100%)`,
            }}
          />
          {showValue && (
            <span className="text-[12.5px] font-mono tabular-nums text-text-muted w-12 text-end">
              {formatValue(value)}
            </span>
          )}
        </div>
      </div>
    </SettingContainer>
  );
};
