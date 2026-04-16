import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface DateRange {
  start: Date;
  end: Date;
}

interface DateRangePickerProps {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  onClose: () => void;
}

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function inRange(day: Date, start: Date, end: Date): boolean {
  const t = day.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function getCalendarDays(year: number, month: number): (Date | null)[] {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  return cells;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  value,
  onChange,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const today = startOfDay(new Date());
  const [viewMonth, setViewMonth] = useState(
    value?.start ?? today,
  );
  const [pickStart, setPickStart] = useState<Date | null>(null);
  const [hoverDate, setHoverDate] = useState<Date | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const days = getCalendarDays(year, month);
  const monthLabel = new Date(year, month).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const prevMonth = () => setViewMonth(new Date(year, month - 1, 1));
  const nextMonth = () => setViewMonth(new Date(year, month + 1, 1));

  const handleDayClick = (day: Date) => {
    if (!pickStart) {
      setPickStart(day);
      return;
    }
    const [s, e] =
      day.getTime() >= pickStart.getTime()
        ? [pickStart, day]
        : [day, pickStart];
    setPickStart(null);
    setHoverDate(null);
    onChange({ start: s, end: e });
    onClose();
  };

  const previewStart =
    pickStart ?? value?.start ?? null;
  const previewEnd = pickStart
    ? hoverDate ?? pickStart
    : value?.end ?? null;
  const [rangeS, rangeE] =
    previewStart && previewEnd
      ? previewEnd.getTime() >= previewStart.getTime()
        ? [previewStart, previewEnd]
        : [previewEnd, previewStart]
      : [null, null];

  return (
    <div
      ref={ref}
      className="absolute top-full mt-1 right-0 z-50 bg-background border border-mid-gray/30 rounded-lg shadow-lg p-3 w-[260px] select-none"
    >
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={prevMonth}
          className="p-1 rounded hover:bg-mid-gray/15 text-text/70 hover:text-text cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <button
          onClick={nextMonth}
          className="p-1 rounded hover:bg-mid-gray/15 text-text/70 hover:text-text cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0 text-center">
        {DAY_LABELS.map((d) => (
          <div
            key={d}
            className="text-[10px] font-medium text-mid-gray/60 py-1"
          >
            {d}
          </div>
        ))}
        {days.map((day, i) => {
          if (!day) {
            return <div key={`e-${i}`} />;
          }

          const isToday = sameDay(day, today);
          const isStart = rangeS ? sameDay(day, rangeS) : false;
          const isEnd = rangeE ? sameDay(day, rangeE) : false;
          const isInRange =
            rangeS && rangeE && !isStart && !isEnd
              ? inRange(day, rangeS, rangeE)
              : false;
          const isEndpoint = isStart || isEnd;

          return (
            <button
              key={day.toISOString()}
              onClick={() => handleDayClick(day)}
              onMouseEnter={() => setHoverDate(day)}
              className={`w-8 h-8 mx-auto text-xs rounded-md flex items-center justify-center transition-colors cursor-pointer
                ${isEndpoint ? "bg-logo-primary text-white font-semibold" : ""}
                ${isInRange ? "bg-logo-primary/15 text-text" : ""}
                ${!isEndpoint && !isInRange ? "hover:bg-logo-primary/10 text-text/80" : ""}
                ${isToday ? "ring-2 ring-logo-primary ring-inset font-semibold" : ""}
                ${isToday && !isEndpoint ? "text-logo-primary" : ""}
              `}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>

      {(value || pickStart) && (
        <div className="mt-2 pt-2 border-t border-mid-gray/15 flex justify-between items-center">
          {pickStart && (
            <span className="text-xs text-mid-gray/60">
              Select end date...
            </span>
          )}
          <button
            onClick={() => {
              setPickStart(null);
              setHoverDate(null);
              onChange(null);
            }}
            className="text-xs text-mid-gray/60 hover:text-mid-gray underline ml-auto cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
};
