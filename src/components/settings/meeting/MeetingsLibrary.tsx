import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  Calendar,
  FileJson,
  GalleryVerticalEnd,
  List as ListIcon,
  Loader2,
  Settings2,
  Tag,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { DateRangePicker, type DateRange } from "../../ui/DateRangePicker";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { PageHeader } from "../../ui/PageHeader";
import { MeetingTranscriptEditor } from "./MeetingTranscriptEditor";
import { MeetingNotesEditor } from "./MeetingNotesEditor";
import { commands } from "../../../bindings";
import { useReveal, type RevealTarget } from "@/lib/reveal";
import type {
  MeetingNotes,
  MeetingSegment,
  MeetingSpeaker,
  MeetingSummaryRow,
} from "../../../bindings";

/**
 * The meeting library — the counterpart to Notes.
 *
 * Search runs in SQL rather than in the browser so it covers transcript text,
 * not just the titles that happen to be loaded. Rows expand in place to show
 * the summary and full transcript, which keeps the list scannable while making
 * a single meeting readable without a separate screen.
 */

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDuration(startedAt: number, endedAt: number | null): string {
  if (!endedAt) return "—";
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60));
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const ToolbarButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`h-8 w-8 shrink-0 flex items-center justify-center rounded-md border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? "bg-accent/15 border-accent/40 text-accent-bright"
        : "bg-fill-1 border-hairline-strong text-text-muted hover:text-accent-bright hover:border-accent/40"
    }`}
  >
    {children}
  </button>
);

type ViewMode = "timeline" | "byApp" | "list";
type SortMode = "newest" | "oldest" | "longest";

interface ExpandedState {
  segments: MeetingSegment[];
}

export const MeetingsLibrary: React.FC = () => {
  const { t } = useTranslation();

  const [rows, setRows] = useState<MeetingSummaryRow[]>([]);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange | null>(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedState | null>(null);
  // Rename and tagging are per-row and committed explicitly, so a half-typed
  // value is never written.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [taggingId, setTaggingId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [showRetention, setShowRetention] = useState(false);
  const [exporting, setExporting] = useState<"md" | "json" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await commands.browseMeetings(
      query.trim() || null,
      range ? Math.floor(range.start.getTime() / 1000) : null,
      range ? Math.floor(range.end.getTime() / 1000) : null,
      200,
    );
    setLoading(false);
    if (result.status === "ok") setRows(result.data);
    else toast.error(result.error);
  }, [query, range]);

  // Debounced so typing does not issue a query per keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(handle);
  }, [load]);

  useEffect(() => {
    void commands.listAllMeetingTags().then((result) => {
      if (result.status === "ok") setKnownTags(result.data);
    });
  }, [rows]);

  const commitRename = async (meetingId: string) => {
    const title = titleDraft.trim();
    setRenamingId(null);
    if (!title) return;
    const result = await commands.setMeetingTitle(meetingId, title);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    setRows((previous) =>
      previous.map((row) =>
        row.meeting.id === meetingId
          ? { ...row, meeting: { ...row.meeting, title } }
          : row,
      ),
    );
  };

  const commitTag = async (meetingId: string) => {
    const name = tagDraft.trim();
    setTagDraft("");
    setTaggingId(null);
    if (!name) return;
    const result = await commands.addMeetingTag(meetingId, name);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    setRows((previous) =>
      previous.map((row) =>
        row.meeting.id === meetingId ? { ...row, tags: result.data } : row,
      ),
    );
  };

  const updateNotes = useCallback((meetingId: string, notes: MeetingNotes) => {
    setRows((previous) =>
      previous.map((row) =>
        row.meeting.id === meetingId ? { ...row, notes } : row,
      ),
    );
  }, []);

  const dropTag = async (meetingId: string, name: string) => {
    const result = await commands.removeMeetingTag(meetingId, name);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    setRows((previous) =>
      previous.map((row) =>
        row.meeting.id === meetingId ? { ...row, tags: result.data } : row,
      ),
    );
  };

  const toggleExpanded = async (meetingId: string) => {
    if (expandedId === meetingId) {
      setExpandedId(null);
      setExpanded(null);
      return;
    }
    setExpandedId(meetingId);
    setExpanded(null);
    const segments = await commands.getMeetingSegments(meetingId);
    if (segments.status === "ok") setExpanded({ segments: segments.data });
  };

  // Arriving from a citation in Ask. The library already loads the most recent
  // 200 meetings, so the usual case is a row that is present but off-screen and
  // collapsed; a filter left over from a previous visit is the one thing that
  // could hide it, so it goes first.
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const revealMeeting = useCallback(
    async (target: RevealTarget) => {
      const id = target.meetingId;
      if (id === undefined) return;

      setQuery("");
      setRange(null);
      setTagFilter(null);

      const result = await commands.browseMeetings(null, null, null, 200);
      if (result.status !== "ok") {
        toast.error(result.error);
        return;
      }
      setRows(result.data);
      if (!result.data.some((row) => row.meeting.id === id)) {
        toast.error(t("meeting.library.revealNotFound"));
        return;
      }

      setRevealedId(id);
      setExpandedId(id);
      setExpanded(null);
      const segments = await commands.getMeetingSegments(id);
      if (segments.status === "ok") setExpanded({ segments: segments.data });

      // Two frames: one for React to commit the rows, one for layout to settle
      // before we ask the element where it is.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-meeting-id="${id}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }),
      );
      window.setTimeout(() => setRevealedId(null), 2600);
    },
    [t],
  );

  useReveal("meeting", revealMeeting);

  const handleCopy = async (meetingId: string) => {
    const result = await commands.exportMeetingText(meetingId, true);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    await navigator.clipboard.writeText(result.data);
    toast.success(t("meeting.library.copied"));
  };

  const handleExport = async (row: MeetingSummaryRow) => {
    const base = (row.meeting.title ?? "meeting")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase();
    const path = await saveDialog({
      defaultPath: `${base || "meeting"}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Plain text", extensions: ["txt"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!path) return;

    const format = path.endsWith(".json")
      ? "json"
      : path.endsWith(".txt")
        ? "txt"
        : "md";
    const result = await commands.exportMeetingToFile(
      row.meeting.id,
      path,
      format,
    );
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    toast.success(t("meeting.library.exported"), {
      action: {
        label: t("meeting.library.reveal"),
        onClick: () => void commands.revealMeetingExport(path),
      },
    });
  };

  const handleDelete = async (row: MeetingSummaryRow) => {
    const result = await commands.deleteMeeting(row.meeting.id);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    if (expandedId === row.meeting.id) {
      setExpandedId(null);
      setExpanded(null);
    }
    void load();
  };

  const visibleRows = useMemo(() => {
    const filtered = tagFilter
      ? rows.filter((row) =>
          row.tags.some((tag) => tag.toLowerCase() === tagFilter.toLowerCase()),
        )
      : rows;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === "oldest")
        return a.meeting.startedAt - b.meeting.startedAt;
      if (sortMode === "longest") {
        const len = (r: MeetingSummaryRow) =>
          (r.meeting.endedAt ?? r.meeting.startedAt) - r.meeting.startedAt;
        return len(b) - len(a);
      }
      return b.meeting.startedAt - a.meeting.startedAt;
    });
    return sorted;
  }, [rows, tagFilter, sortMode]);

  /**
   * Rows bucketed for the current view. "list" is a single unlabelled group so
   * the render path below stays uniform rather than branching per mode.
   */
  const groups = useMemo(() => {
    if (viewMode === "list") return [{ label: null, rows: visibleRows }];

    const map = new Map<string, MeetingSummaryRow[]>();
    for (const row of visibleRows) {
      const key =
        viewMode === "byApp"
          ? (row.meeting.appDisplayName ?? t("meeting.library.unknownApp"))
          : new Date(row.meeting.startedAt * 1000).toLocaleDateString(
              undefined,
              { dateStyle: "full" },
            );
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].map(([label, rows]) => ({ label, rows }));
  }, [visibleRows, viewMode, t]);

  const handleExportAll = async (format: "md" | "json") => {
    const path = await saveDialog({
      defaultPath: format === "json" ? "meetings.json" : "meetings.md",
      filters:
        format === "json"
          ? [{ name: "JSON", extensions: ["json"] }]
          : [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    setExporting(format);
    const result = await commands.exportAllMeetings(
      path,
      format,
      query.trim() || null,
      range ? Math.floor(range.start.getTime() / 1000) : null,
      range ? Math.floor(range.end.getTime() / 1000) : null,
    );
    setExporting(null);
    if (result.status === "error") {
      toast.error(result.error);
      return;
    }
    toast.success(t("meeting.library.exportedCount", { count: result.data }), {
      action: {
        label: t("meeting.library.reveal"),
        onClick: () => void commands.revealMeetingExport(path),
      },
    });
  };

  const rangeLabel = useMemo(() => {
    if (!range) return t("meeting.library.anyDate");
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(range.start)} – ${fmt(range.end)}`;
  }, [range, t]);

  return (
    <div className="flex w-full flex-col gap-3 pt-1">
      <PageHeader
        title={t("meeting.library.title")}
        description={t("meeting.library.subtitle")}
        actions={
          <SegmentedControl<ViewMode>
            value={viewMode}
            onChange={setViewMode}
            ariaLabel={t("meeting.library.view.label")}
            options={[
              {
                value: "timeline",
                label: t("meeting.library.view.timeline"),
                Icon: GalleryVerticalEnd,
              },
              {
                value: "byApp",
                label: t("meeting.library.view.byApp"),
                Icon: AppWindow,
              },
              {
                value: "list",
                label: t("meeting.library.view.list"),
                Icon: ListIcon,
              },
            ]}
          />
        }
      />

      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("meeting.library.searchPlaceholder")}
            className="h-8 w-full rounded-md border border-hairline-strong bg-fill-1 pl-9 pr-8 text-sm placeholder:text-text-faint focus:border-accent/60 focus:outline-none"
          />
        </div>

        <select
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as SortMode)}
          title={t("meeting.library.sort.label")}
          className="h-8 shrink-0 cursor-pointer appearance-none rounded-md border border-hairline-strong bg-fill-1 px-2 text-sm focus:border-accent/60 focus:outline-none"
        >
          <option value="newest">{t("meeting.library.sort.newest")}</option>
          <option value="oldest">{t("meeting.library.sort.oldest")}</option>
          <option value="longest">{t("meeting.library.sort.longest")}</option>
        </select>

        <div className="mx-0.5 h-6 w-px bg-hairline-strong" />

        {/* Tag filter */}
        <div className="relative">
          <ToolbarButton
            onClick={() => setShowTagFilter((open) => !open)}
            active={showTagFilter || tagFilter !== null}
            title={t("meeting.library.filterByTag")}
          >
            <Tag className="h-4 w-4" />
          </ToolbarButton>
          {showTagFilter && (
            <div
              style={{ position: "absolute" }}
              className="end-0 top-full z-50 mt-1.5 max-h-64 w-48 overflow-y-auto rounded-xl border border-hairline-strong bg-surface-2 p-1 shadow-xl"
            >
              <button
                type="button"
                onClick={() => {
                  setTagFilter(null);
                  setShowTagFilter(false);
                }}
                className={`block w-full rounded px-2 py-1 text-left text-[12px] hover:bg-fill-2 ${
                  tagFilter === null ? "text-accent" : "text-text-muted"
                }`}
              >
                {t("meeting.library.allTags")}
              </button>
              {knownTags.length === 0 ? (
                <p className="px-2 py-1 text-[11px] text-text-faint">
                  {t("meeting.library.noTags")}
                </p>
              ) : (
                knownTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      setTagFilter(tag);
                      setShowTagFilter(false);
                    }}
                    className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-fill-2 ${
                      tagFilter === tag ? "text-accent" : "text-text-muted"
                    }`}
                  >
                    {tag}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <ToolbarButton
          onClick={() => void handleExportAll("json")}
          disabled={exporting !== null}
          title={t("meeting.library.exportAllJson")}
        >
          {exporting === "json" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileJson className="h-4 w-4" />
          )}
        </ToolbarButton>

        <ToolbarButton
          onClick={() => void handleExportAll("md")}
          disabled={exporting !== null}
          title={t("meeting.library.exportAllMarkdown")}
        >
          {exporting === "md" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </ToolbarButton>

        <div className="relative">
          <ToolbarButton
            onClick={() => setShowCalendar((open) => !open)}
            active={showCalendar || range !== null}
            title={t("meeting.library.filterByDate")}
          >
            <Calendar className="h-4 w-4" />
          </ToolbarButton>
          {showCalendar && (
            <DateRangePicker
              value={range}
              onChange={setRange}
              onClose={() => setShowCalendar(false)}
            />
          )}
        </div>

        <ToolbarButton
          onClick={() => setShowRetention((open) => !open)}
          active={showRetention}
          title={t("meeting.library.retention")}
        >
          <Settings2 className="h-4 w-4" />
        </ToolbarButton>
      </div>

      {showRetention && (
        <div className="rounded-xl border border-hairline bg-fill-1 px-3 py-2 text-[12px] text-text-muted">
          {t("meeting.library.retentionHint")}
        </div>
      )}

      {(tagFilter || range) && (
        <div className="flex items-center gap-2 text-[12px] text-text-muted">
          {tagFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-accent">
              {tagFilter}
              <button type="button" onClick={() => setTagFilter(null)}>
                <X width={11} height={11} />
              </button>
            </span>
          )}
          {range && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-accent">
              {rangeLabel}
              <button type="button" onClick={() => setRange(null)}>
                <X width={11} height={11} />
              </button>
            </span>
          )}
        </div>
      )}

      <datalist id="meeting-tag-suggestions">
        {knownTags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>

      {/* List */}
      {loading && rows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-text-subtle">
          {t("meeting.library.loading")}
        </p>
      ) : visibleRows.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-text-subtle">
          {query || range || tagFilter
            ? t("meeting.library.noMatches")
            : t("meeting.library.empty")}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label ?? "all"}>
              {group.label && (
                <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                  {group.label}
                  <span className="ml-1.5 text-text-faint">
                    {group.rows.length}
                  </span>
                </p>
              )}
              <div className="overflow-hidden rounded-xl border border-hairline">
                {group.rows.map((row, index) => {
                  const isOpen = expandedId === row.meeting.id;
                  return (
                    <div
                      key={row.meeting.id}
                      data-meeting-id={row.meeting.id}
                      className={`${
                        index > 0 ? "border-t border-hairline" : ""
                      } ${
                        revealedId === row.meeting.id
                          ? "rounded-lg bg-accent/5 ring-2 ring-accent/60"
                          : ""
                      }`}
                    >
                      <div className="group flex items-start gap-2 px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => void toggleExpanded(row.meeting.id)}
                          className="mt-0.5 shrink-0 text-text-faint hover:text-text"
                          aria-label={t("meeting.library.expand")}
                        >
                          {isOpen ? (
                            <ChevronDown width={16} height={16} />
                          ) : (
                            <ChevronRight width={16} height={16} />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          {renamingId === row.meeting.id ? (
                            <div className="mb-1 flex items-center gap-1">
                              <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) =>
                                  setTitleDraft(event.target.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter")
                                    void commitRename(row.meeting.id);
                                  if (event.key === "Escape")
                                    setRenamingId(null);
                                }}
                                placeholder={t(
                                  "meeting.library.titlePlaceholder",
                                )}
                                className="w-56 rounded border border-hairline-strong bg-surface-2 px-1.5 py-0.5 text-[13px] outline-none"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  void commitRename(row.meeting.id)
                                }
                                className="rounded p-1 text-text-faint hover:text-success"
                                title={t("meeting.library.saveTitle")}
                              >
                                <Check width={14} height={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenamingId(null)}
                                className="rounded p-1 text-text-faint hover:text-text"
                                title={t("meeting.library.cancelRename")}
                              >
                                <X width={14} height={14} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  void toggleExpanded(row.meeting.id)
                                }
                                className="min-w-0 truncate text-left text-[13px] font-medium"
                              >
                                {row.meeting.title ??
                                  t("meeting.library.untitled")}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingId(row.meeting.id);
                                  setTitleDraft(row.meeting.title ?? "");
                                }}
                                title={t("meeting.library.rename")}
                                className="shrink-0 rounded p-0.5 text-text-faint opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
                              >
                                <Pencil width={13} height={13} />
                              </button>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => void toggleExpanded(row.meeting.id)}
                            className="block w-full text-left"
                          >
                            <p className="mt-0.5 truncate text-[11px] text-text-subtle">
                              {formatDate(row.meeting.startedAt)}
                              {" · "}
                              {formatDuration(
                                row.meeting.startedAt,
                                row.meeting.endedAt,
                              )}
                              {" · "}
                              {t("meeting.library.lineCount", {
                                count: Number(row.segmentCount),
                              })}
                              {row.meeting.appDisplayName
                                ? ` · ${row.meeting.appDisplayName}`
                                : ""}
                              {!row.meeting.capturedSystemAudio
                                ? ` · ${t("meeting.library.micOnly")}`
                                : ""}
                              {/* Which meetings you actually wrote something
                                  about is the fastest way to find one again. */}
                              {row.notes.enhanced
                                ? ` · ${t("meeting.notes.badgeEnhanced")}`
                                : row.notes.notes
                                  ? ` · ${t("meeting.notes.badgeMine")}`
                                  : ""}
                            </p>
                          </button>

                          {/* Tags — same affordance as Notes: chips with an inline
                        add field and click-to-remove. */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {row.tags.map((tag) => (
                              <span
                                key={tag}
                                className="group/tag inline-flex items-center gap-1 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] text-text-muted"
                              >
                                {tag}
                                <button
                                  type="button"
                                  onClick={() =>
                                    void dropTag(row.meeting.id, tag)
                                  }
                                  title={t("meeting.library.removeTag")}
                                  className="text-text-faint hover:text-danger"
                                >
                                  <X width={11} height={11} />
                                </button>
                              </span>
                            ))}

                            {taggingId === row.meeting.id ? (
                              <input
                                autoFocus
                                list="meeting-tag-suggestions"
                                value={tagDraft}
                                onChange={(event) =>
                                  setTagDraft(event.target.value)
                                }
                                onBlur={() => void commitTag(row.meeting.id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter")
                                    void commitTag(row.meeting.id);
                                  if (event.key === "Escape") {
                                    setTagDraft("");
                                    setTaggingId(null);
                                  }
                                }}
                                placeholder={t(
                                  "meeting.library.tagPlaceholder",
                                )}
                                className="w-28 rounded-full border border-hairline-strong bg-surface-2 px-2 py-0.5 text-[11px] outline-none"
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setTaggingId(row.meeting.id);
                                  setTagDraft("");
                                }}
                                className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-hairline-strong px-2 py-0.5 text-[11px] text-text-faint hover:text-text"
                              >
                                <Plus width={11} height={11} />
                                {t("meeting.library.addTag")}
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleCopy(row.meeting.id)}
                            title={t("meeting.library.copy")}
                            className="rounded p-1.5 text-text-faint hover:bg-fill-2 hover:text-text"
                          >
                            <Copy width={15} height={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleExport(row)}
                            title={t("meeting.library.export")}
                            className="rounded p-1.5 text-text-faint hover:bg-fill-2 hover:text-text"
                          >
                            <Download width={15} height={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(row)}
                            title={t("meeting.library.delete")}
                            className="rounded p-1.5 text-text-faint hover:bg-fill-2 hover:text-danger"
                          >
                            <Trash2 width={15} height={15} />
                          </button>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="border-t border-hairline bg-fill-1 px-3 py-3">
                          {/* Notes lead: once someone has written them, they
                              are the point of the meeting and the transcript
                              is the evidence behind them. */}
                          <MeetingNotesEditor
                            meetingId={row.meeting.id}
                            notes={row.notes}
                            hasTranscript={Number(row.segmentCount) > 0}
                            onChange={(notes) =>
                              updateNotes(row.meeting.id, notes)
                            }
                          />

                          {row.summary && (
                            <div className="mb-3">
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                                {t("meeting.library.summary")}
                              </p>
                              <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-snug text-text-muted">
                                {row.summary}
                              </pre>
                            </div>
                          )}

                          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle">
                            {t("meeting.library.transcript")}
                          </p>
                          {!expanded ? (
                            <p className="text-[12px] text-text-subtle">
                              {t("meeting.library.loading")}
                            </p>
                          ) : expanded.segments.length === 0 ? (
                            <p className="text-[12px] text-text-subtle">
                              {t("meeting.library.noTranscript")}
                            </p>
                          ) : (
                            <MeetingTranscriptEditor
                              segments={expanded.segments}
                              onChange={setExpanded}
                            />
                          )}

                          <button
                            type="button"
                            onClick={() => void handleExport(row)}
                            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-2.5 py-1 text-[12px] text-text-muted hover:text-text"
                          >
                            <FolderOpen width={14} height={14} />
                            {t("meeting.library.exportThis")}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
