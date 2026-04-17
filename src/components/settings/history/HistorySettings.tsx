import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileAudio,
  FileJson,
  FolderOpen,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryTag,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { formatDateTime } from "@/utils/dateFormat";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { DateRangePicker, type DateRange } from "../../ui/DateRangePicker";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";
import { useSettings } from "@/hooks/useSettings";
import { getAppInfoByName, categoryColors } from "@/lib/appIcons";

const IconButton: React.FC<{
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`p-1.5 rounded-md flex items-center justify-center transition-colors cursor-pointer disabled:cursor-not-allowed disabled:text-text/20 ${
      active
        ? "text-logo-primary hover:text-logo-primary/80"
        : "text-text/50 hover:text-logo-primary"
    }`}
    title={title}
  >
    {children}
  </button>
);

/** 32px-square toolbar button — matches the search input / sort select height. */
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
        : "bg-white/[0.03] border-hairline-strong text-text-muted hover:text-accent-bright hover:border-accent/40"
    }`}
  >
    {children}
  </button>
);

const PAGE_SIZE = 30;

type SortMode = "newest" | "oldest" | "saved";

function sortEntries(entries: HistoryEntry[], mode: SortMode): HistoryEntry[] {
  if (mode === "newest") return entries;
  if (mode === "oldest")
    return [...entries].sort((a, b) => a.timestamp - b.timestamp);
  // "saved": pinned first, preserving newest order within each bucket
  return [...entries].sort((a, b) => {
    if (a.saved === b.saved) return b.timestamp - a.timestamp;
    return a.saved ? -1 : 1;
  });
}

function dayKey(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(timestamp: number, locale: string): string {
  const d = new Date(timestamp * 1000);
  const now = new Date();
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round(
    (startOfDay(now) - startOfDay(d)) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) {
    return d.toLocaleDateString(locale, { weekday: "long" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale, {
    month: "long",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export const HistorySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const osType = useOsType();
  const { getSetting } = useSettings();
  const retentionPeriod = getSetting("recording_retention_period") ?? "never";
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  // Sort state
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  // Retention popover
  const [showRetention, setShowRetention] = useState(false);

  // Date range filter
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Multi-select state. Checkboxes are always visible on hover; the bulk-action
  // bar appears above the list whenever at least one entry is selected.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Search + tag filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<HistoryEntry[] | null>(
    null,
  );
  const [isSearching, setIsSearching] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSearchMode =
    searchQuery.trim().length > 0 ||
    selectedTags.length > 0 ||
    dateRange !== null;

  const refreshAllTags = useCallback(async () => {
    try {
      const result = await commands.listAllHistoryTags();
      if (result.status === "ok") setAllTags(result.data);
    } catch (error) {
      console.error("Failed to load tag list:", error);
    }
  }, []);

  useEffect(() => {
    refreshAllTags();
  }, [refreshAllTags]);

  // Keep ref in sync for use in IntersectionObserver callback
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const loadPage = useCallback(async (cursor?: number) => {
    const isFirstPage = cursor === undefined;
    if (!isFirstPage && loadingRef.current) return;
    loadingRef.current = true;

    if (isFirstPage) setLoading(true);

    try {
      const result = await commands.getHistoryEntries(
        cursor ?? null,
        PAGE_SIZE,
      );
      if (result.status === "ok") {
        const { entries: newEntries, has_more } = result.data;
        setEntries((prev) =>
          isFirstPage ? newEntries : [...prev, ...newEntries],
        );
        setHasMore(has_more);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadPage();
  }, [loadPage]);

  // Debounced search
  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

    const trimmed = searchQuery.trim();
    const hasFilters = selectedTags.length > 0 || dateRange !== null;
    if (!trimmed && !hasFilters) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    const startTs = dateRange
      ? Math.floor(dateRange.start.getTime() / 1000)
      : null;
    const endTs = dateRange
      ? Math.floor(dateRange.end.getTime() / 1000) + 86400
      : null;

    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const result = hasFilters
          ? await commands.filterHistoryEntries(
              trimmed || null,
              selectedTags,
              100,
              startTs,
              endTs,
            )
          : await commands.searchHistoryEntries(trimmed, 50, startTs, endTs);
        if (result.status === "ok") {
          setSearchResults(result.data);
        } else {
          setSearchResults([]);
        }
      } catch (error) {
        console.error("Search failed:", error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [searchQuery, selectedTags, dateRange]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (loading || isSearchMode) return;

    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const first = observerEntries[0];
        if (first.isIntersecting) {
          const lastEntry = entriesRef.current[entriesRef.current.length - 1];
          if (lastEntry) {
            loadPage(lastEntry.id);
          }
        }
      },
      { threshold: 0 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadPage, isSearchMode]);

  // Listen for new entries added from the transcription pipeline
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        setEntries((prev) => [payload.entry, ...prev]);
        // If searching, re-run search to include new entry
        if (isSearchMode) {
          setSearchQuery((q) => q); // trigger re-search via useEffect
        }
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
        if (searchResults) {
          setSearchResults((prev) =>
            prev
              ? prev.map((e) => (e.id === payload.entry.id ? payload.entry : e))
              : prev,
          );
        }
        // Tags may have changed — refresh the distinct-tag list for the filter bar.
        refreshAllTags();
      } else if (payload.action === "deleted") {
        refreshAllTags();
        setSelected((prev) => {
          if (!prev.has(payload.id)) return prev;
          const next = new Set(prev);
          next.delete(payload.id);
          return next;
        });
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isSearchMode, searchResults, refreshAllTags]);

  const toggleSaved = async (id: number) => {
    const updateList = (list: HistoryEntry[]) =>
      list.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e));

    setEntries((prev) => updateList(prev));
    if (searchResults)
      setSearchResults((prev) => (prev ? updateList(prev) : prev));

    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") {
        setEntries((prev) => updateList(prev));
        if (searchResults)
          setSearchResults((prev) => (prev ? updateList(prev) : prev));
      }
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      setEntries((prev) => updateList(prev));
      if (searchResults)
        setSearchResults((prev) => (prev ? updateList(prev) : prev));
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status === "ok") {
          if (osType === "linux") {
            const fileData = await readFile(result.data);
            const blob = new Blob([fileData], { type: "audio/wav" });
            return URL.createObjectURL(blob);
          }
          return convertFileSrc(result.data, "asset");
        }
        return null;
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Optimistic: strip from the list immediately, then hand the whole batch
    // to the backend, which deletes all rows in a single transaction.
    const idSet = new Set(ids);
    setEntries((prev) => prev.filter((e) => !idSet.has(e.id)));
    if (searchResults)
      setSearchResults((prev) =>
        prev ? prev.filter((e) => !idSet.has(e.id)) : prev,
      );
    clearSelection();
    try {
      const result = await commands.bulkDeleteHistoryEntries(ids);
      if (result.status !== "ok") {
        toast.error(
          t("settings.history.bulkDeleteError", "Failed to delete entries"),
        );
        loadPage();
      }
    } catch (error) {
      console.error("Bulk delete failed:", error);
      toast.error(String(error));
      loadPage();
    }
  };

  const bulkToggleSaved = async (save: boolean) => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const apply = (list: HistoryEntry[]) =>
      list.map((e) => (selected.has(e.id) ? { ...e, saved: save } : e));
    setEntries((prev) => apply(prev));
    if (searchResults) setSearchResults((prev) => (prev ? apply(prev) : prev));
    try {
      // Existing endpoint toggles, so only touch entries whose current state
      // differs from the target.
      const needsFlip = ids.filter((id) => {
        const inList =
          entries.find((e) => e.id === id) ??
          searchResults?.find((e) => e.id === id);
        return inList ? inList.saved !== save : false;
      });
      await Promise.all(
        needsFlip.map((id) => commands.toggleHistoryEntrySaved(id)),
      );
    } catch (error) {
      console.error("Bulk save toggle failed:", error);
      toast.error(String(error));
      loadPage();
    }
    clearSelection();
  };

  const deleteAudioEntry = async (id: number) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    if (searchResults)
      setSearchResults((prev) =>
        prev ? prev.filter((e) => e.id !== id) : prev,
      );

    try {
      const result = await commands.deleteHistoryEntry(id);
      if (result.status !== "ok") {
        loadPage();
      }
    } catch (error) {
      console.error("Failed to delete entry:", error);
      loadPage();
    }
  };

  const updateTitle = async (id: number, title: string | null) => {
    try {
      const result = await commands.updateHistoryEntryTitle(id, title);
      if (result.status === "ok") {
        const updated = result.data;
        setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
        if (searchResults)
          setSearchResults((prev) =>
            prev ? prev.map((e) => (e.id === id ? updated : e)) : prev,
          );
      } else {
        toast.error(String(result.error));
      }
    } catch (error) {
      console.error("Failed to update title:", error);
      toast.error(String(error));
    }
  };

  const addTag = async (id: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const result = await commands.addHistoryTag(id, trimmed);
      if (result.status !== "ok") {
        toast.error(String(result.error));
      }
      // Entry refresh comes via the history-updated event emitted by the backend.
    } catch (error) {
      console.error("Failed to add tag:", error);
      toast.error(String(error));
    }
  };

  const removeTag = async (id: number, name: string) => {
    try {
      const result = await commands.removeHistoryTag(id, name);
      if (result.status !== "ok") toast.error(String(result.error));
    } catch (error) {
      console.error("Failed to remove tag:", error);
      toast.error(String(error));
    }
  };

  const generateMetadata = async (id: number) => {
    try {
      const result = await commands.generateHistoryMetadata(id);
      if (result.status === "ok") {
        const updated = result.data;
        setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)));
        if (searchResults)
          setSearchResults((prev) =>
            prev ? prev.map((e) => (e.id === id ? updated : e)) : prev,
          );
        toast.success(
          t("settings.history.ai.success", "Generated title and tags"),
        );
      } else {
        toast.error(String(result.error));
      }
    } catch (error) {
      console.error("AI metadata generation failed:", error);
      toast.error(String(error));
    }
  };

  const toggleFilterTag = (name: string) => {
    setSelectedTags((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  };

  const retryHistoryEntry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  };

  const [transcribingFile, setTranscribingFile] = useState(false);
  const [exportingJson, setExportingJson] = useState(false);
  const [exportingDocx, setExportingDocx] = useState(false);

  const exportHistory = async (format: "json" | "docx") => {
    const isJson = format === "json";
    const setter = isJson ? setExportingJson : setExportingDocx;
    setter(true);
    try {
      const path = await saveDialog({
        defaultPath: isJson ? "history.json" : "history.docx",
        filters: isJson
          ? [
              {
                name: t("settings.history.export.jsonFilter", "JSON File"),
                extensions: ["json"],
              },
            ]
          : [
              {
                name: t("settings.history.export.docxFilter", "Word Document"),
                extensions: ["docx"],
              },
            ],
      });
      if (!path) return;
      const result = await commands.exportHistory(path, format);
      if (result.status === "ok") {
        toast.success(
          t("settings.history.export.success", "History exported successfully"),
        );
      } else {
        toast.error(String(result.error));
      }
    } catch (error) {
      console.error("Export failed:", error);
      toast.error(String(error));
    } finally {
      setter(false);
    }
  };

  const openRecordingsFolder = async () => {
    try {
      const result = await commands.openRecordingsFolder();
      if (result.status !== "ok") {
        throw new Error(String(result.error));
      }
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  const transcribeFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          {
            name: t("settings.history.fileTranscribe.filter", "Audio Files"),
            extensions: ["wav", "mp3", "m4a", "ogg", "flac", "aac", "opus"],
          },
        ],
      });

      if (!selected || typeof selected !== "string") return;
      const filePath = selected;

      setTranscribingFile(true);
      const result = await commands.transcribeAudioFile(filePath);
      if (result.status === "ok") {
        setEntries((prev) => [result.data, ...prev]);
        toast.success(
          t("settings.history.fileTranscribe.success", "File transcribed"),
        );
      } else {
        toast.error(String(result.error));
      }
    } catch (error) {
      console.error("File transcription failed:", error);
      toast.error(String(error));
    } finally {
      setTranscribingFile(false);
    }
  };

  const rawDisplayed = isSearchMode ? (searchResults ?? []) : entries;
  const displayedEntries = sortEntries(rawDisplayed, sortMode);
  const locale = i18n.language;

  // Group consecutive entries by local day (only in newest/oldest modes where order is by time)
  const groupedEntries: Array<
    | { type: "header"; key: string; label: string }
    | { type: "entry"; entry: HistoryEntry }
  > = [];
  if (sortMode === "newest" || sortMode === "oldest") {
    let lastKey = "";
    for (const entry of displayedEntries) {
      const key = dayKey(entry.timestamp);
      if (key !== lastKey) {
        groupedEntries.push({
          type: "header",
          key,
          label: dayLabel(entry.timestamp, locale),
        });
        lastKey = key;
      }
      groupedEntries.push({ type: "entry", entry });
    }
  } else {
    for (const entry of displayedEntries)
      groupedEntries.push({ type: "entry", entry });
  }

  const renderEntry = (entry: HistoryEntry) => (
    <HistoryEntryComponent
      key={entry.id}
      entry={entry}
      searchQuery={searchQuery.trim().length > 0 ? searchQuery : ""}
      onToggleSaved={() => toggleSaved(entry.id)}
      onCopyText={() =>
        copyToClipboard(entry.post_processed_text ?? entry.transcription_text)
      }
      getAudioUrl={getAudioUrl}
      deleteAudio={deleteAudioEntry}
      retryTranscription={retryHistoryEntry}
      updateTitle={updateTitle}
      onAddTag={(name) => addTag(entry.id, name)}
      onRemoveTag={(name) => removeTag(entry.id, name)}
      onGenerateMetadata={() => generateMetadata(entry.id)}
      isSelected={selected.has(entry.id)}
      onToggleSelect={() => toggleSelect(entry.id)}
      selectionActive={selected.size > 0}
    />
  );

  const visibleEntryIds = displayedEntries.map((e) => e.id);
  const allVisibleSelected =
    visibleEntryIds.length > 0 &&
    visibleEntryIds.every((id) => selected.has(id));
  const anyVisibleSelected = visibleEntryIds.some((id) => selected.has(id));
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleEntryIds.forEach((id) => next.delete(id));
      } else {
        visibleEntryIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };
  const anySelectedAreSaved = Array.from(selected).some((id) => {
    const entry =
      entries.find((e) => e.id === id) ??
      searchResults?.find((e) => e.id === id);
    return entry?.saved ?? false;
  });

  let content: React.ReactNode;

  if (loading && !isSearchMode) {
    content = (
      <div className="px-4 py-3 text-center text-text/60">
        {t("settings.history.loading")}
      </div>
    );
  } else if (isSearching) {
    content = (
      <div className="px-4 py-3 text-center text-text/60">
        {t("settings.history.searching", "Searching…")}
      </div>
    );
  } else if (displayedEntries.length === 0) {
    content = (
      <div className="px-4 py-3 text-center text-text/60">
        {isSearchMode
          ? t("settings.history.noResults", "No results found")
          : t("settings.history.empty")}
      </div>
    );
  } else {
    content = (
      <>
        <div className="divide-y divide-[color:var(--color-hairline)]">
          {groupedEntries.map((item) =>
            item.type === "header" ? (
              <div
                key={`h-${item.key}`}
                className="px-4 py-1.5 text-[11px] uppercase tracking-wide font-semibold text-text-muted bg-white/[0.02] sticky top-0 z-[1]"
              >
                {item.label}
              </div>
            ) : (
              renderEntry(item.entry)
            ),
          )}
        </div>
        {/* Sentinel for infinite scroll (only in browse mode) */}
        {!isSearchMode && <div ref={sentinelRef} className="h-1" />}
      </>
    );
  }

  return (
    <div className="w-full flex flex-col gap-3 pt-1">
      {/* Toolbar: search + sort + actions — all 32px tall for a clean grid */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-faint pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t(
              "settings.history.searchPlaceholder",
              "Search transcriptions…",
            )}
            className="w-full h-8 pl-9 pr-8 text-sm bg-white/[0.03] border border-hairline-strong rounded-md
                       focus:outline-none focus:border-accent/60 placeholder:text-text-faint"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="relative">
          {sortMode === "oldest" ? (
            <ArrowUpNarrowWide className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint pointer-events-none" />
          ) : (
            <ArrowDownNarrowWide className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-faint pointer-events-none" />
          )}
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="h-8 pl-7 pr-2 bg-white/[0.03] border border-hairline-strong rounded-md text-sm
                       focus:outline-none focus:border-accent/60 cursor-pointer appearance-none"
            title={t("settings.history.sort", "Sort")}
          >
            <option value="newest">
              {t("settings.history.sortNewest", "Newest")}
            </option>
            <option value="oldest">
              {t("settings.history.sortOldest", "Oldest")}
            </option>
            <option value="saved">
              {t("settings.history.sortSaved", "Starred first")}
            </option>
          </select>
        </div>

        <div className="w-px h-6 bg-hairline-strong mx-0.5" />

        <ToolbarButton
          onClick={transcribeFile}
          disabled={transcribingFile}
          title={t(
            "settings.history.fileTranscribe.button",
            "Transcribe audio file",
          )}
        >
          {transcribingFile ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileAudio className="w-4 h-4" />
          )}
        </ToolbarButton>
        <ToolbarButton
          onClick={openRecordingsFolder}
          title={t("settings.history.openFolder")}
        >
          <FolderOpen className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => exportHistory("json")}
          disabled={exportingJson || exportingDocx}
          title={t("settings.history.export.jsonButton", "Export as JSON")}
        >
          {exportingJson ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileJson className="w-4 h-4" />
          )}
        </ToolbarButton>
        <ToolbarButton
          onClick={() => exportHistory("docx")}
          disabled={exportingJson || exportingDocx}
          title={t(
            "settings.history.export.docxButton",
            "Export as Word document",
          )}
        >
          {exportingDocx ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton
            onClick={() => setShowDatePicker((v) => !v)}
            active={showDatePicker || dateRange !== null}
            title={t(
              "settings.history.dateFilter.button",
              "Filter by date range",
            )}
          >
            <Calendar className="w-4 h-4" />
          </ToolbarButton>
          {showDatePicker && (
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              onClose={() => setShowDatePicker(false)}
            />
          )}
        </div>
        <ToolbarButton
          onClick={() => setShowRetention((v) => !v)}
          active={showRetention}
          title={t("settings.history.storageGroup", "Storage & retention")}
        >
          <Settings2 className="w-4 h-4" />
        </ToolbarButton>
      </div>

      {/* Retention popover — compact, inline, collapsible */}
      {showRetention && (
        <div className="surface-card-inlay py-1 divide-y divide-[color:var(--color-hairline)]">
          <RecordingRetentionPeriodSelector
            descriptionMode="tooltip"
            grouped={true}
          />
          {retentionPeriod === "preserve_limit" && (
            <HistoryLimit descriptionMode="tooltip" grouped={true} />
          )}
        </div>
      )}

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <TagIcon className="w-3.5 h-3.5 text-text-faint shrink-0" />
          {allTags.map((tag) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleFilterTag(tag)}
                className={`pill pill-interactive ${active ? "pill-accent" : ""}`}
                title={
                  active
                    ? t("settings.history.tags.removeFilter", "Remove filter")
                    : t("settings.history.tags.addFilter", "Filter by tag")
                }
              >
                {tag}
              </button>
            );
          })}
          {selectedTags.length > 0 && (
            <button
              onClick={() => setSelectedTags([])}
              className="text-xs text-text-faint hover:text-text-muted underline ml-1"
            >
              {t("settings.history.tags.clearFilters", "Clear")}
            </button>
          )}
        </div>
      )}

      {dateRange && (
        <div className="flex items-center gap-1.5">
          <Calendar className="w-3.5 h-3.5 text-text-faint shrink-0" />
          <span className="pill pill-accent">
            {dateRange.start.toLocaleDateString(i18n.language)} –{" "}
            {dateRange.end.toLocaleDateString(i18n.language)}
            <button
              onClick={() => setDateRange(null)}
              className="hover:text-logo-primary/70 cursor-pointer"
              title={t(
                "settings.history.dateFilter.clear",
                "Clear date filter",
              )}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 h-10 rounded-lg border border-accent/40 bg-accent/10 text-sm">
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            title={
              allVisibleSelected
                ? t("settings.history.bulk.deselectAll", "Deselect all visible")
                : t("settings.history.bulk.selectAll", "Select all visible")
            }
          >
            <input
              type="checkbox"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el)
                  el.indeterminate = !allVisibleSelected && anyVisibleSelected;
              }}
              onChange={toggleSelectAllVisible}
              className="w-4 h-4 accent-logo-primary cursor-pointer"
            />
            <span className="font-medium text-logo-primary">
              {t("settings.history.bulk.selectedCount", "{{count}} selected", {
                count: selected.size,
              })}
            </span>
          </label>
          <div className="flex-1" />
          <button
            onClick={() => bulkToggleSaved(!anySelectedAreSaved)}
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-text/80 hover:text-logo-primary hover:bg-logo-primary/10 transition-colors cursor-pointer"
            title={
              anySelectedAreSaved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              className="w-3.5 h-3.5"
              fill={anySelectedAreSaved ? "none" : "currentColor"}
            />
            {anySelectedAreSaved
              ? t("settings.history.bulk.unstar", "Unstar")
              : t("settings.history.bulk.star", "Star")}
          </button>
          <button
            onClick={bulkDelete}
            className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t("settings.history.bulk.delete", "Delete")}
          </button>
          <button
            onClick={clearSelection}
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text hover:bg-white/[0.05] transition-colors cursor-pointer"
            title={t("settings.history.bulk.clear", "Clear selection")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="surface-card-inlay overflow-visible">{content}</div>
    </div>
  );
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  searchQuery: string;
  onToggleSaved: () => void;
  onCopyText: () => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
  retryTranscription: (id: number) => Promise<void>;
  updateTitle: (id: number, title: string | null) => Promise<void>;
  onAddTag: (name: string) => Promise<void>;
  onRemoveTag: (name: string) => Promise<void>;
  onGenerateMetadata: () => Promise<void>;
  isSelected: boolean;
  onToggleSelect: () => void;
  /** True when any entry is selected — keeps checkboxes visible even when not hovering. */
  selectionActive: boolean;
}

/** Highlight matching text in a string */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const parts = text.split(
    new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
  );
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="bg-logo-primary/30 text-text rounded-sm">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

const EntryMoreMenu: React.FC<{
  onGenerate: () => void;
  onRetranscribe: () => void;
  onDelete: () => void;
  generating: boolean;
  retrying: boolean;
  hasTranscription: boolean;
}> = ({
  onGenerate,
  onRetranscribe,
  onDelete,
  generating,
  retrying,
  hasTranscription,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={containerRef} className="relative">
      <IconButton
        onClick={() => setOpen((v) => !v)}
        disabled={retrying}
        active={open}
        title={t("settings.history.moreActions", "More actions")}
      >
        <MoreHorizontal width={16} height={16} />
      </IconButton>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-20 min-w-[180px] rounded-md border border-hairline-strong
                     bg-surface-2 shadow-[0_20px_40px_-10px_rgba(0,0,0,0.6)] py-1 text-sm"
          role="menu"
        >
          <button
            role="menuitem"
            onClick={() => run(onGenerate)}
            disabled={retrying || generating || !hasTranscription}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text/90 hover:bg-white/[0.05]
                       disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {generating ? (
              <Loader2 width={14} height={14} className="animate-spin" />
            ) : (
              <Sparkles width={14} height={14} />
            )}
            {t("settings.history.ai.generate", "Generate title & tags with AI")}
          </button>
          <button
            role="menuitem"
            onClick={() => run(onRetranscribe)}
            disabled={retrying}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text/90 hover:bg-white/[0.05]
                       disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <RotateCcw width={14} height={14} />
            {t("settings.history.retranscribe")}
          </button>
          <div className="my-1 h-px bg-hairline-strong" />
          <button
            role="menuitem"
            onClick={() => run(onDelete)}
            disabled={retrying}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10
                       disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <Trash2 width={14} height={14} />
            {t("settings.history.delete")}
          </button>
        </div>
      )}
    </div>
  );
};

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  searchQuery,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
  updateTitle,
  onAddTag,
  onRemoveTag,
  onGenerateMetadata,
  isSelected,
  onToggleSelect,
  selectionActive,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(entry.user_title ?? "");
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const tags: HistoryTag[] = entry.tags ?? [];

  useEffect(() => {
    setTitleDraft(entry.user_title ?? "");
  }, [entry.user_title]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  useEffect(() => {
    if (addingTag) tagInputRef.current?.focus();
  }, [addingTag]);

  const commitTag = async () => {
    const next = tagDraft.trim();
    setTagDraft("");
    setAddingTag(false);
    if (next) await onAddTag(next);
  };

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      await onGenerateMetadata();
    } finally {
      setGenerating(false);
    }
  };

  const commitTitle = async () => {
    const next = titleDraft.trim();
    const current = entry.user_title ?? "";
    if (next === current) {
      setEditingTitle(false);
      return;
    }
    await updateTitle(entry.id, next.length > 0 ? next : null);
    setEditingTitle(false);
  };

  const hasTranscription = entry.transcription_text.trim().length > 0;
  const hasPostProcessed =
    !!entry.post_processed_text && entry.post_processed_text.trim().length > 0;
  const displayText = hasPostProcessed
    ? entry.post_processed_text!
    : entry.transcription_text;
  const isLong = displayText.length > 300;

  const handleLoadAudio = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const handleCopyText = () => {
    if (!hasTranscription) return;
    onCopyText();
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("settings.history.deleteError"));
    }
  };

  const handleRetranscribe = async () => {
    try {
      setRetrying(true);
      await retryTranscription(entry.id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("settings.history.retranscribeError"));
    } finally {
      setRetrying(false);
    }
  };

  const formattedDate = formatDateTime(String(entry.timestamp), i18n.language);

  const renderedText = searchQuery
    ? highlightText(displayText, searchQuery)
    : displayText;

  const truncated =
    isLong && !expanded ? displayText.slice(0, 300) + "…" : displayText;

  const renderedTruncated = searchQuery
    ? highlightText(truncated, searchQuery)
    : truncated;

  const displayTitle = entry.user_title?.trim() || formattedDate;
  const showSubtitle = !!entry.user_title?.trim();

  return (
    <div
      className={`group/entry relative pl-9 pr-4 py-2 pb-5 flex flex-col gap-3 transition-colors ${
        isSelected ? "bg-logo-primary/5" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggleSelect}
        onClick={(e) => e.stopPropagation()}
        className={`absolute left-3 top-3.5 w-4 h-4 accent-logo-primary cursor-pointer shrink-0 transition-opacity ${
          selectionActive || isSelected
            ? "opacity-100"
            : "opacity-0 group-hover/entry:opacity-100 focus:opacity-100"
        }`}
        aria-label={t("settings.history.bulk.selectEntry", "Select entry")}
      />
      <div className="flex justify-between items-center gap-2">
        <div className="flex-1 min-w-0 flex flex-col">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  setTitleDraft(entry.user_title ?? "");
                  setEditingTitle(false);
                }
              }}
              placeholder={t(
                "settings.history.titlePlaceholder",
                "Add a title…",
              )}
              className="text-sm font-medium bg-white/[0.03] border border-hairline-strong rounded px-2 py-0.5 w-full
                         focus:outline-none focus:border-accent/60"
            />
          ) : (
            <button
              onClick={() => setEditingTitle(true)}
              className="group flex items-center gap-1.5 text-left"
              title={t("settings.history.editTitle", "Edit title")}
            >
              <span className="text-sm font-medium truncate">
                {displayTitle}
              </span>
              <Pencil className="w-3 h-3 text-text-faint opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          )}
          {showSubtitle && !editingTitle && (
            <span className="text-sm text-text-muted truncate">
              {formattedDate}
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0">
          <IconButton
            onClick={handleCopyText}
            disabled={!hasTranscription || retrying}
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check width={16} height={16} />
            ) : (
              <Copy width={16} height={16} />
            )}
          </IconButton>
          <IconButton
            onClick={onToggleSaved}
            disabled={retrying}
            active={entry.saved}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              width={16}
              height={16}
              fill={entry.saved ? "currentColor" : "none"}
            />
          </IconButton>
          <EntryMoreMenu
            onGenerate={handleGenerate}
            onRetranscribe={handleRetranscribe}
            onDelete={handleDeleteEntry}
            generating={generating}
            retrying={retrying}
            hasTranscription={hasTranscription}
          />
        </div>
      </div>

      {!retrying && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {entry.source_app &&
            (() => {
              const appInfo = getAppInfoByName(entry.source_app);
              const colors = appInfo ? categoryColors[appInfo.category] : null;
              return (
                <span
                  className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium border ${
                    colors
                      ? `${colors.chipBg} ${colors.chipBorder} ${colors.chipText}`
                      : "bg-white/[0.04] border-hairline-strong text-text-muted"
                  }`}
                  title={t("settings.history.sourceApp", "Captured in")}
                >
                  {appInfo && (
                    <img
                      src={appInfo.icon}
                      alt=""
                      className="w-3.5 h-3.5 rounded-[3px] shrink-0"
                    />
                  )}
                  {appInfo?.label ?? entry.source_app}
                </span>
              );
            })()}
          {tags.map((tag) => (
            <span
              key={tag.name}
              className={`pill ${tag.auto ? "pill-accent" : ""}`}
              title={
                tag.auto
                  ? t("settings.history.tags.autoApplied", "Auto-applied by AI")
                  : undefined
              }
            >
              {tag.name}
              <button
                onClick={() => onRemoveTag(tag.name)}
                className="opacity-50 hover:opacity-100 transition-opacity"
                aria-label={t("settings.history.tags.remove", "Remove tag")}
              >
                <X width={10} height={10} />
              </button>
            </span>
          ))}
          {addingTag ? (
            <input
              ref={tagInputRef}
              type="text"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={commitTag}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTag();
                } else if (e.key === "Escape") {
                  setTagDraft("");
                  setAddingTag(false);
                }
              }}
              placeholder={t("settings.history.tags.placeholder", "tag…")}
              maxLength={64}
              className="text-xs px-2 py-0.5 w-24 bg-white/[0.03] border border-hairline-strong rounded-full text-text
                         focus:outline-none focus:border-accent/60"
            />
          ) : (
            <button
              onClick={() => setAddingTag(true)}
              className="pill pill-dashed pill-interactive"
              title={t("settings.history.tags.add", "Add tag")}
            >
              <Plus width={10} height={10} />
              {t("settings.history.tags.add", "Add tag")}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <p
          className={`italic text-sm pb-1 ${
            retrying
              ? ""
              : hasTranscription
                ? "text-text/90 select-text cursor-text whitespace-pre-wrap break-words"
                : "text-text/40"
          }`}
          style={
            retrying
              ? { animation: "transcribe-pulse 3s ease-in-out infinite" }
              : undefined
          }
        >
          {retrying && (
            <style>{`
              @keyframes transcribe-pulse {
                0%, 100% { color: color-mix(in srgb, var(--color-text) 40%, transparent); }
                50% { color: color-mix(in srgb, var(--color-text) 90%, transparent); }
              }
            `}</style>
          )}
          {retrying
            ? t("settings.history.transcribing")
            : hasTranscription
              ? isLong
                ? renderedTruncated
                : renderedText
              : t("settings.history.transcriptionFailed")}
        </p>

        {isLong && !retrying && hasTranscription && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-logo-primary/80 hover:text-logo-primary self-start"
          >
            {expanded ? (
              <>
                <ChevronUp width={12} height={12} />
                {t("settings.history.showLess", "Show less")}
              </>
            ) : (
              <>
                <ChevronDown width={12} height={12} />
                {t("settings.history.showMore", "Show more")}
              </>
            )}
          </button>
        )}
      </div>

      <AudioPlayer onLoadRequest={handleLoadAudio} className="w-full" />
    </div>
  );
};
