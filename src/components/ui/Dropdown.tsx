import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  className?: string;
  selectedValue: string | null;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onRefresh?: () => void;
}

const GAP = 4;
const VIEWPORT_PADDING = 12;
const MAX_MENU_HEIGHT = 240;

interface MenuCoords {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  selectedValue,
  onSelect,
  className = "",
  placeholder = "Select an option...",
  disabled = false,
  onRefresh,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * Menus are portalled to `document.body` and positioned `fixed`, matching
   * `Tooltip`.
   *
   * Absolutely-positioned menus stayed inside the scrolling settings pane:
   * they stretched its scroll extent (so opening a dropdown made the page
   * longer) and were clipped by any ancestor that hid its overflow. A portal
   * floats above everything and cannot affect layout — which is how a menu is
   * expected to behave.
   */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - GAP - VIEWPORT_PADDING;
    const above = rect.top - GAP - VIEWPORT_PADDING;
    // Flip upward only when that genuinely gives the menu more room.
    const flip = below < Math.min(MAX_MENU_HEIGHT, above) && above > below;
    const maxHeight = Math.max(
      120,
      Math.min(MAX_MENU_HEIGHT, flip ? above : below),
    );

    let left = rect.left;
    if (left + rect.width > window.innerWidth - VIEWPORT_PADDING) {
      left = window.innerWidth - rect.width - VIEWPORT_PADDING;
    }

    setCoords({
      top: flip ? rect.top - GAP - maxHeight : rect.bottom + GAP,
      left: Math.max(VIEWPORT_PADDING, left),
      width: rect.width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    updatePosition();
    // `true` captures scrolls on any ancestor, not just the window, so the
    // menu tracks the settings pane as it moves.
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    // The menu lives outside the trigger's DOM subtree, so a containment test
    // against the trigger alone would treat clicking an option as an outside
    // click and close the menu before the option's handler ran.
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );

  const handleSelect = (value: string) => {
    onSelect(value);
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onRefresh) onRefresh();
    setIsOpen(!isOpen);
  };

  return (
    <div className={`relative ${className}`} ref={triggerRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`h-8 px-3 text-[13px] font-medium bg-fill-1 border border-hairline-strong rounded-lg min-w-[200px] w-full text-start text-text flex items-center justify-between transition-all duration-150 ${
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "hover:bg-fill-2 hover:border-accent/40 cursor-pointer focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20"
        } ${isOpen ? "border-accent/60 bg-fill-2" : ""}`}
        onClick={handleToggle}
        disabled={disabled}
      >
        <span className="truncate">{selectedOption?.label || placeholder}</span>
        <svg
          className={`w-3.5 h-3.5 ms-2 shrink-0 text-text-faint transition-transform duration-200 ${isOpen ? "transform rotate-180 text-accent-bright" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {isOpen &&
        !disabled &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              width: coords?.width,
              maxHeight: coords?.maxHeight ?? MAX_MENU_HEIGHT,
              zIndex: 9999,
              opacity: coords ? 1 : 0,
            }}
            className="glass-raised rounded-xl overflow-y-auto p-1 animate-rise"
          >
            {options.length === 0 ? (
              <div className="px-2 py-1.5 text-[13px] text-text-faint">
                {t("common.noOptionsFound")}
              </div>
            ) : (
              options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selectedValue === option.value}
                  className={`w-full px-2 py-1.5 text-[13px] text-start rounded-md transition-colors duration-150 ${
                    selectedValue === option.value
                      ? "bg-accent/15 text-accent-bright font-medium"
                      : "text-text hover:bg-fill-2"
                  } ${option.disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  onClick={() => handleSelect(option.value)}
                  disabled={option.disabled}
                >
                  <span className="block truncate">{option.label}</span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
};
