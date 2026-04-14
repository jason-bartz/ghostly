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
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  Download,
  FileAudio,
  FileJson,
  FolderOpen,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { formatDateTime } from "@/utils/dateFormat";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { HistoryLimit } from "../HistoryLimit";
import { RecordingRetentionPeriodSelector } from "../RecordingRetentionPeriod";

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
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  // Sort state
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<HistoryEntry[] | null>(
    null,
  );
  const [isSearching, setIsSearching] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSearchMode = searchQuery.trim().length > 0;

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

    if (!searchQuery.trim()) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const result = await commands.searchHistoryEntries(
          searchQuery.trim(),
          50,
        );
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
  }, [searchQuery]);

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
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [isSearchMode, searchResults]);

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

  const retryHistoryEntry = async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  };

  const pasteHistoryEntry = async (id: number) => {
    const result = await commands.pasteHistoryEntry(id);
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
      searchQuery={isSearchMode ? searchQuery : ""}
      onToggleSaved={() => toggleSaved(entry.id)}
      onCopyText={() =>
        copyToClipboard(entry.post_processed_text ?? entry.transcription_text)
      }
      getAudioUrl={getAudioUrl}
      deleteAudio={deleteAudioEntry}
      retryTranscription={retryHistoryEntry}
      pasteEntry={pasteHistoryEntry}
      updateTitle={updateTitle}
    />
  );

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
        <div className="divide-y divide-mid-gray/20">
          {groupedEntries.map((item) =>
            item.type === "header" ? (
              <div
                key={`h-${item.key}`}
                className="px-4 py-1.5 text-[11px] uppercase tracking-wide font-semibold text-mid-gray/80 bg-mid-gray/5 sticky top-0 z-[1]"
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
    <div className="max-w-3xl w-full mx-auto space-y-6">
      {/* ── Storage & Retention settings ── */}
      <SettingsGroup title={t("settings.history.storageGroup")}>
        <HistoryLimit descriptionMode="tooltip" grouped={true} />
        <RecordingRetentionPeriodSelector
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <div className="space-y-2">
        <div className="px-4 flex items-center justify-between">
          <div>
            <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
              {t("settings.history.title")}
            </h2>
          </div>
          <div className="flex items-center">
            <IconButton
              onClick={() => exportHistory("json")}
              disabled={exportingJson || exportingDocx}
              title={t("settings.history.export.jsonButton", "Export as JSON")}
            >
              {exportingJson ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileJson className="w-4 h-4" />
              )}
            </IconButton>
            <IconButton
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
            </IconButton>
            <div className="w-px h-4 bg-mid-gray/20 mx-1" />
            <IconButton
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
            </IconButton>
            <IconButton
              onClick={openRecordingsFolder}
              title={t("settings.history.openFolder")}
            >
              <FolderOpen className="w-4 h-4" />
            </IconButton>
          </div>
        </div>

        {/* Search + sort */}
        <div className="px-4 flex items-center gap-2">
          <div className="relative flex items-center flex-1">
            <Search className="absolute left-3 w-4 h-4 text-mid-gray/60 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t(
                "settings.history.searchPlaceholder",
                "Search transcriptions…",
              )}
              className="w-full pl-9 pr-8 py-1.5 text-sm bg-background border border-mid-gray/30 rounded-md
                         focus:outline-none focus:border-logo-primary/60 placeholder:text-mid-gray/40"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 text-mid-gray/50 hover:text-mid-gray"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 text-xs">
            {sortMode === "oldest" ? (
              <ArrowUpNarrowWide className="w-3.5 h-3.5 text-mid-gray/60" />
            ) : (
              <ArrowDownNarrowWide className="w-3.5 h-3.5 text-mid-gray/60" />
            )}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="py-1.5 px-2 bg-background border border-mid-gray/30 rounded-md text-sm
                         focus:outline-none focus:border-logo-primary/60 cursor-pointer"
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
        </div>

        <div className="bg-background border border-mid-gray/20 rounded-lg overflow-visible">
          {content}
        </div>
      </div>
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
  pasteEntry: (id: number) => Promise<void>;
  updateTitle: (id: number, title: string | null) => Promise<void>;
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

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  searchQuery,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
  retryTranscription,
  pasteEntry,
  updateTitle,
}) => {
  const { t, i18n } = useTranslation();
  const [showCopied, setShowCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(entry.user_title ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitleDraft(entry.user_title ?? "");
  }, [entry.user_title]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

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

  const handlePaste = async () => {
    try {
      setPasting(true);
      await pasteEntry(entry.id);
    } catch (error) {
      console.error("Failed to paste entry:", error);
      toast.error(t("settings.history.pasteError", "Failed to paste text"));
    } finally {
      setPasting(false);
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
    <div className="px-4 py-2 pb-5 flex flex-col gap-3">
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
              className="text-sm font-medium bg-background border border-mid-gray/30 rounded px-2 py-0.5 w-full
                         focus:outline-none focus:border-logo-primary/60"
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
              <Pencil className="w-3 h-3 text-mid-gray/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </button>
          )}
          {showSubtitle && !editingTitle && (
            <span className="text-xs text-mid-gray/70 truncate">
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
            onClick={handlePaste}
            disabled={!hasTranscription || retrying || pasting}
            title={t("settings.history.pasteText", "Paste to active app")}
          >
            <Clipboard width={16} height={16} />
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
          <IconButton
            onClick={handleRetranscribe}
            disabled={retrying}
            title={t("settings.history.retranscribe")}
          >
            <RotateCcw
              width={16}
              height={16}
              style={
                retrying
                  ? { animation: "spin 1s linear infinite reverse" }
                  : undefined
              }
            />
          </IconButton>
          <IconButton
            onClick={handleDeleteEntry}
            disabled={retrying}
            title={t("settings.history.delete")}
          >
            <Trash2 width={16} height={16} />
          </IconButton>
        </div>
      </div>

      {hasPostProcessed && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs px-1.5 py-0.5 rounded-sm bg-logo-primary/15 text-logo-primary font-medium">
            {entry.post_process_prompt ??
              t("settings.history.postProcessed", "Post-processed")}
          </span>
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
