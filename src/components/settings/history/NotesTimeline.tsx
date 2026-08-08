import React from "react";
import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react";
import type { HistoryEntry } from "@/bindings";
import { getAppInfoByName, categoryColors } from "@/lib/appIcons";

export interface TimelineGroup {
  key: string;
  label: string;
  /** Secondary line — "12 notes · 4 apps", or an app's note count. */
  meta: string;
  entries: HistoryEntry[];
}

interface NotesTimelineProps {
  groups: TimelineGroup[];
  renderEntry: (entry: HistoryEntry) => React.ReactNode;
  /** Rendered under the last group; used for the infinite-scroll sentinel. */
  footer?: React.ReactNode;
}

/**
 * Chronological rail view.
 *
 * The point of a timeline over a flat list is that it makes *rhythm* visible:
 * a morning burst in Slack, a long afternoon in the editor, a gap. A list
 * hides that. The rail carries a node per note, coloured by the app it was
 * captured in, so the shape of a day is legible before reading a word.
 *
 * Layout is a single continuous 1px rail behind absolutely-positioned nodes,
 * rather than a per-row border, so the line doesn't break between entries of
 * different heights.
 */
export const NotesTimeline: React.FC<NotesTimelineProps> = ({
  groups,
  renderEntry,
  footer,
}) => {
  const { t } = useTranslation();

  return (
    <div className="relative">
      {groups.map((group) => (
        <section key={group.key} className="relative">
          {/* Day marker. Sticky so the current day stays legible while
              scrolling through a long stretch of notes. */}
          <div className="sticky top-0 z-20 -mx-px">
            <div className="glass flex items-baseline gap-2.5 px-4 py-2 border-x-0 border-t-0 rounded-none">
              <h3 className="text-[12.5px] font-semibold tracking-tight text-text">
                {group.label}
              </h3>
              <span className="text-[11px] text-text-faint tabular-nums">
                {group.meta}
              </span>
            </div>
          </div>

          <div className="relative">
            {/* The rail. Inset to align with the node centres; stops short at
                the bottom so it doesn't collide with the next day marker. */}
            <span
              aria-hidden
              className="absolute left-[22px] top-0 bottom-0 w-px bg-gradient-to-b from-hairline-strong via-hairline to-transparent"
            />

            {group.entries.map((entry) => {
              const appInfo = entry.source_app
                ? getAppInfoByName(entry.source_app)
                : null;
              const colors = appInfo ? categoryColors[appInfo.category] : null;

              return (
                <div key={entry.id} className="relative flex">
                  {/* Node column: time stamp above an app-coloured dot. */}
                  <div className="relative w-[44px] shrink-0 pt-3.5 flex flex-col items-center">
                    <span
                      className={`relative z-10 flex items-center justify-center w-[22px] h-[22px] rounded-full ring-4 ring-[color:var(--color-canvas)] ${
                        colors?.tagClass ?? "bg-fill-3"
                      }`}
                      title={entry.source_app ?? undefined}
                    >
                      {appInfo ? (
                        <img
                          src={appInfo.icon}
                          alt=""
                          className="w-3.5 h-3.5 rounded-[3px]"
                        />
                      ) : (
                        <Mic className="w-3 h-3 text-text-faint" />
                      )}
                    </span>
                    <span className="mt-1.5 text-[10px] tabular-nums text-text-faint leading-none">
                      {timeOfDay(entry.timestamp)}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0 border-b border-hairline">
                    {renderEntry(entry)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {groups.length === 0 && (
        <div className="px-4 py-10 text-center text-text-faint text-sm">
          {t("settings.history.empty")}
        </div>
      )}

      {footer}
    </div>
  );
};

/** `9:41 AM` style stamp, localised by the browser. */
function timeOfDay(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
