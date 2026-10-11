import { useState, useEffect, useRef, useMemo, useCallback, useDeferredValue } from "react";
import { MessageSquare, Database, Search, FolderOpen, Loader2 } from "@/lib/icons";
import { useTabStore } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsTouchOnly } from "@/hooks/use-is-touch-only";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useRemoteFileSearch } from "@/hooks/use-remote-file-search";
import { useExtensionStore } from "@/stores/extension-store";
import { api } from "@/lib/api-client";
import { basename } from "@/lib/utils";
import { scoreFileSearchFast, compareScores, getFilename, type FileSearchScore } from "@/lib/score-file-search";
import { splitSourceLocation, type SourceLine } from "@/lib/source-location";
import { CommandPaletteFilterChips } from "@/components/layout/command-palette-filter-chips";
import { fileIconElement } from "@/lib/file-icons";
import { composeCommands, type CommandContext } from "@/lib/commands/command-registry";
import { DB_TYPE_LABELS, type DbType } from "../../../shared/db-types";
import { openTableTab } from "@/components/database/explorer/open-db-tabs";
import { NewDesignDialogHost, useDesignCommands } from "./command-palette-design-commands";
import { useDbPaletteCommands } from "./command-palette-db-commands";
import { paletteItemFromCommand, type CommandItem } from "./command-palette-items";

/** Max results to display — prevents rendering thousands of matches */
const MAX_RESULTS = 100;

interface DbSearchResult {
  connectionId: number;
  connectionName: string;
  connectionType: string;
  connectionColor: string | null;
  tableName: string;
  schemaName: string;
}

/** Recursively flatten file tree into file-only list */
function flattenFiles(nodes: FileNode[]): { name: string; path: string }[] {
  const result: { name: string; path: string }[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      result.push({ name: node.name, path: node.path });
    }
    if (node.children) {
      result.push(...flattenFiles(node.children));
    }
  }
  return result;
}

/** Check if query looks like an absolute path (Unix: /, ~/ | Windows: C:\, ~\) */
function isPathQuery(q: string): boolean {
  if (!q) return false;
  return q.startsWith("/") || q.startsWith("~/") || q.startsWith("~\\") || /^[A-Za-z]:[/\\]/.test(q);
}

/** Extract the directory portion of a path for API call */
function extractDir(q: string): string {
  // Normalize to forward slash for splitting
  const normalized = q.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return q;
  const lastSlash = Math.max(normalized.lastIndexOf("/"), q.lastIndexOf("\\"));
  return lastSlash > 0 ? q.slice(0, lastSlash + 1) : q;
}

// Cache: dir path → file list
const fsCache = new Map<string, string[]>();

export function CommandPalette({ open, onClose, initialQuery = "" }: { open: boolean; onClose: () => void; initialQuery?: string }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [fsFiles, setFsFiles] = useState<string[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [dbResults, setDbResults] = useState<DbSearchResult[]>([]);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openTab = useTabStore((s) => s.openTab);
  const updateTab = useTabStore((s) => s.updateTab);
  const activeProject = useProjectStore((s) => s.activeProject);
  const fileIndex = useFileStore((s) => s.fileIndex);
  const indexStatus = useFileStore((s) => s.indexStatus);
  const indexProject = useFileStore((s) => s.indexProject);
  const indexRemote = useFileStore((s) => s.indexRemote);
  const loadIndex = useFileStore((s) => s.loadIndex);
  const openIndexReader = useFileStore((s) => s.openIndexReader);
  const fileTree = useFileStore((s) => s.tree);
  const getBinding = useKeybindingsStore((s) => s.getBinding);
  const extContributions = useExtensionStore((s) => s.contributions);
  const isMobile = useIsMobile();
  const isTouchOnly = useIsTouchOnly();
  const lspEnabled = useSettingsStore((s) => s.lspEnabled);

  /**
   * A query may name one place in a file — `app.ts:120`, `app.ts:120-140`, `app.ts#L120` —
   * which is what a Markdown file link falls back to when its path resolves to nothing.
   * The suffix has to come off before searching, or it is matched against filenames that
   * never contain it and the query finds nothing at all.
   */
  const typed = useMemo(() => splitSourceLocation(query) ?? { path: query }, [query]);
  const searchPath = useMemo(
    () => splitSourceLocation(deferredQuery)?.path ?? deferredQuery,
    [deferredQuery],
  );
  // A project too long to send is searched on the server as the query changes. What comes back
  // is ranked below with everything else, exactly as the list itself would have been.
  const remoteFiles = useRemoteFileSearch(activeProject?.name, searchPath, {
    enabled: open && indexRemote && !!searchPath.trim() && !isPathQuery(searchPath),
  });

  /**
   * Read when an item is actually picked, rather than closed over per command: the file
   * commands are built from the entire project index, and rebuilding thousands of them on
   * each keystroke of `:120` costs far more than carrying the line this way.
   */
  const lineTargetRef = useRef<SourceLine | undefined>(undefined);
  useEffect(() => { lineTargetRef.current = typed.line; }, [typed.line]);

  /** Open a file as an editor tab, jumping to the line the query named. */
  const openFileTab = useCallback((path: string, title: string, projectId: string | null, meta?: { projectName: string }) => {
    const line = lineTargetRef.current;
    const metadata: Record<string, unknown> = { ...meta, filePath: path };
    if (line) Object.assign(metadata, { lineNumber: line.start, endLine: line.end, revealAt: Date.now() });
    const id = openTab({ type: "editor", title, projectId, metadata, closable: true });
    // A tab already open on this file is deduped by filePath and keeps the metadata it was
    // opened with, so the new line has to be pushed onto it for the reveal effect to fire.
    if (line && id) updateTab(id, { metadata });
    onClose();
  }, [openTab, updateTab, onClose]);

  // Fetch filesystem files when path query changes directory
  const fetchFsFiles = useCallback(async (dir: string) => {
    if (fsCache.has(dir)) {
      setFsFiles(fsCache.get(dir)!);
      return;
    }
    setFsLoading(true);
    try {
      const files = await api.get<string[]>(`/api/fs/list?dir=${encodeURIComponent(dir)}`);
      fsCache.set(dir, files);
      setFsFiles(files);
    } catch {
      setFsFiles([]);
    } finally {
      setFsLoading(false);
    }
  }, []);

  // When query changes and looks like a path, fetch files
  useEffect(() => {
    if (!isPathQuery(typed.path)) {
      setFsFiles([]);
      return;
    }
    const dir = extractDir(typed.path);
    fetchFsFiles(dir);
  }, [typed.path, fetchFsFiles]);

  // Debounced DB table search
  useEffect(() => {
    if (isPathQuery(query) || query.trim().length < 2) { setDbResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const data = await api.get<DbSearchResult[]>(`/api/db/search?q=${encodeURIComponent(query.trim())}`);
        setDbResults(data ?? []);
      } catch { setDbResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const designCommands = useDesignCommands(activeProject?.name ?? null, open);
  const dbPaletteCommands = useDbPaletteCommands(isMobile);

  /** What the registry's commands see when one is listed or picked here. */
  const commandContext = useMemo<CommandContext>(() => ({
    project: activeProject ?? null, isMobile, isTouchOnly, lspEnabled, getBinding, extensions: extContributions,
  }), [activeProject, isMobile, isTouchOnly, lspEnabled, getBinding, extContributions]);

  // Action commands: the registry's, in its order.
  const actionCommands = useMemo<CommandItem[]>(
    () => composeCommands(commandContext, { design: designCommands, db: dbPaletteCommands })
      .map((cmd) => paletteItemFromCommand(cmd, commandContext, onClose)),
    [commandContext, designCommands, dbPaletteCommands, onClose],
  );

  // File commands — from index when ready, fallback to flattened tree
  const fileCommands = useMemo<CommandItem[]>(() => {
    const projectId = activeProject?.name ?? null;
    const meta = activeProject ? { projectName: activeProject.name } : undefined;
    // Filter index to files only — directories are in the index for palette "open folder" affordances but not for file-open commands
    const files = indexRemote
      ? remoteFiles
      : indexStatus === "ready" && indexProject === activeProject?.name ? fileIndex.filter((e) => e.type === "file") : flattenFiles(fileTree);

    return files.map((f) => ({
      id: `file:${f.path}`,
      label: f.name,
      hint: f.path,
      icon: fileIconElement(f.name),
      group: "file" as const,
      keywords: f.path,
      // Propagate gitignore flag for muted rendering (only present on /files/index entries)
      isIgnored: ("isIgnored" in f ? f.isIgnored : undefined) as boolean | undefined,
      action: () => openFileTab(f.path, f.name, projectId, meta),
    }));
  }, [indexStatus, indexProject, indexRemote, remoteFiles, fileIndex, fileTree, activeProject, openFileTab]);

  // Filesystem commands — from cached API results
  const fsCommands = useMemo<CommandItem[]>(() => {
    const projectId = activeProject?.name ?? null;
    const meta = activeProject ? { projectName: activeProject.name } : undefined;

    return fsFiles.map((fp) => {
      const name = basename(fp);
      return {
        id: `fs:${fp}`,
        label: name,
        hint: fp,
        icon: FolderOpen,
        group: "fs" as const,
        keywords: fp,
        action: () => openFileTab(fp, name, projectId, meta),
      };
    });
  }, [fsFiles, activeProject, openFileTab]);

  const dbCommands = useMemo<CommandItem[]>(() => dbResults.map((r) => ({
    id: `db:${r.connectionId}:${r.schemaName}.${r.tableName}`,
    label: r.tableName,
    hint: `${r.connectionName} (${DB_TYPE_LABELS[r.connectionType as DbType] ?? r.connectionType})`,
    icon: Database,
    group: "db" as const,
    connectionColor: r.connectionColor,
    action: () => {
      // The table cache holds each connection's own database, so the tab names no other.
      openTableTab({
        target: { kind: "connection", connectionId: r.connectionId },
        connectionName: r.connectionName, dbType: r.connectionType as DbType, connectionColor: r.connectionColor,
      }, { schema: r.schemaName || null, name: r.tableName });
      onClose();
    },
  })), [dbResults, onClose]);

  const allCommands = useMemo(
    () => [...actionCommands, ...fileCommands],
    [actionCommands, fileCommands],
  );

  /**
   * Precomputed lowercase search index — avoids re-allocating thousands of
   * lowercased strings per keystroke. Recomputed only when allCommands changes.
   */
  const searchIndex = useMemo(() => {
    return allCommands.map((cmd) => {
      const path = cmd.keywords ?? cmd.label;
      const pathLower = path.toLowerCase();
      return {
        cmd,
        filenameLower: getFilename(pathLower),
        pathLower,
        labelLen: cmd.label.length,
        depth: path.split("/").length,
      };
    });
  }, [allCommands]);

  const filtered = useMemo(() => {
    // Path mode — search filesystem results using filename portion only
    if (isPathQuery(searchPath)) {
      const lastSlash = searchPath.lastIndexOf("/");
      const fileFilter = lastSlash >= 0 ? searchPath.slice(lastSlash + 1).toLowerCase() : "";
      if (!fileFilter) return fsCommands.slice(0, 50);
      return fsCommands.filter((c) => {
        const name = c.label.toLowerCase();
        const path = (c.keywords ?? "").toLowerCase();
        return name.includes(fileFilter) || path.includes(fileFilter);
      }).slice(0, 50);
    }

    // Normal mode
    if (!searchPath.trim()) return actionCommands;
    // Strip leading ./ or ../ — index paths are relative without dot prefix
    const qLower = searchPath.toLowerCase().replace(/^\.\.?\//, "");
    const scored: Array<{ cmd: CommandItem; score: FileSearchScore }> = [];
    for (const entry of searchIndex) {
      const s = scoreFileSearchFast(qLower, entry.filenameLower, entry.pathLower, entry.labelLen, entry.depth);
      if (s) scored.push({ cmd: entry.cmd, score: s });
    }
    scored.sort((a, b) => compareScores(a.score, b.score));
    const matched = scored.slice(0, MAX_RESULTS).map((s) => s.cmd);
    // Prepend DB results (already filtered server-side) when query is 2+ chars
    return deferredQuery.trim().length >= 2 ? [...dbCommands, ...matched] : matched;
  }, [searchIndex, actionCommands, fsCommands, dbCommands, deferredQuery, searchPath]);

  // Stable set of groups that have data (pre-query) — prevents chip flashing
  const availableGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const cmd of allCommands) groups.add(cmd.group);
    if (dbResults.length > 0) groups.add("db");
    if (fsFiles.length > 0) groups.add("fs");
    return Array.from(groups);
  }, [allCommands, dbResults.length, fsFiles.length]);

  // Per-group counts from search-filtered results (updates with query)
  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cmd of filtered) counts[cmd.group] = (counts[cmd.group] ?? 0) + 1;
    return counts;
  }, [filtered]);

  // Final display list — apply group filters as post-process
  const displayItems = useMemo(() => {
    if (activeFilters.size === 0) return filtered;
    return filtered.filter((cmd) => activeFilters.has(cmd.group));
  }, [filtered, activeFilters]);

  const toggleFilter = useCallback((group: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
    setSelectedIdx(0);
  }, []);

  // Load the file index as the palette opens, or refresh it if files changed since, and keep it
  // current while it stays open. Not on `indexStatus`: a failed load would retry itself in a
  // loop — the hint below has a retry.
  useEffect(() => {
    if (open && activeProject) return openIndexReader(activeProject.name);
  }, [open, activeProject, openIndexReader]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery(initialQuery || "");
      setSelectedIdx(0);
      setFsFiles([]);
      setDbResults([]);
      setActiveFilters(new Set());
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp selected index when display list changes
  useEffect(() => {
    setSelectedIdx((prev) => Math.min(prev, Math.max(displayItems.length - 1, 0)));
  }, [displayItems.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  /** Open chat tab with query as message (used by "Ask AI" fallback) */
  const askAi = useCallback(() => {
    if (!query.trim()) return;
    const projectId = activeProject?.name ?? null;
    openTab({
      type: "chat",
      title: "AI Chat",
      projectId,
      metadata: { projectName: activeProject?.name, pendingMessage: query.trim() },
      closable: true,
    });
    onClose();
  }, [query, activeProject, openTab, onClose]);

  function handleKeyDown(e: React.KeyboardEvent) {
    const len = displayItems.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (len > 0) setSelectedIdx((i) => (i + 1) % len);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (len > 0) setSelectedIdx((i) => (i - 1 + len) % len);
        break;
      case "Enter":
        e.preventDefault();
        if (len > 0) {
          displayItems[selectedIdx]?.action();
        } else if (query.trim()) {
          askAi();
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  // The dialog host stays mounted while the palette is closed: New Design opens after it
  // closes. Both branches keep it as the fragment's first child so React keeps its state.
  if (!open) return <><NewDesignDialogHost /></>;

  const pathMode = isPathQuery(typed.path);

  return (
    <>
    <NewDesignDialogHost />
    <div className="fixed inset-0 z-50 flex items-end md:items-start justify-center md:pt-[20vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-md rounded-t-xl md:rounded-xl border border-border bg-background shadow-2xl overflow-hidden max-h-[80vh] md:max-h-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="size-4 text-text-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search actions & files... (type / or ~/ for filesystem)"
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle"
          />
          {fsLoading && <Loader2 className="size-3.5 animate-spin text-text-subtle shrink-0" />}
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle font-mono">
            ESC
          </kbd>
        </div>

        {/* Path mode hint */}
        {pathMode && !fsLoading && fsFiles.length === 0 && query.length < 4 && (
          <div className="px-3 py-2 text-xs text-text-subtle border-b border-border/50">
            Type a directory path to browse files (e.g. ~/Projects/)
          </div>
        )}

        {/* Index status hints — non-blocking, muted */}
        {!pathMode && (indexStatus === "loading" || indexStatus === "idle") && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50">
            <Loader2 className="size-3 animate-spin text-text-subtle shrink-0" />
            <span className="text-[11px] text-text-subtle italic">Indexing project…</span>
          </div>
        )}
        {!pathMode && indexStatus === "error" && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50">
            <span className="text-[11px] text-text-subtle">Failed to build file index —</span>
            <button
              onClick={() => activeProject && loadIndex(activeProject.name)}
              className="text-[11px] text-primary hover:underline"
            >
              retry
            </button>
          </div>
        )}

        {/* Filter chips — hidden in path mode */}
        {!pathMode && (
          <CommandPaletteFilterChips
            availableGroups={availableGroups}
            groupCounts={groupCounts}
            activeFilters={activeFilters}
            onToggle={toggleFilter}
          />
        )}

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {displayItems.length === 0 ? (
            fsLoading ? (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">Searching...</p>
            ) : activeFilters.size > 0 && filtered.length > 0 ? (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">No results in selected filters</p>
            ) : query.trim() ? (
              <button
                onClick={askAi}
                className="flex items-center gap-3 w-full px-3 py-3 text-sm text-left text-text-secondary hover:bg-accent/15 hover:text-text-primary transition-colors"
              >
                <MessageSquare className="size-4 shrink-0 text-primary" />
                <span>Ask AI: <span className="text-text-primary font-medium">{query.trim().slice(0, 60)}</span></span>
              </button>
            ) : (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">No results</p>
            )
          ) : (
            displayItems.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  className={`flex items-center gap-3 w-full px-3 py-2 text-sm text-left transition-colors ${
                    i === selectedIdx
                      ? "bg-accent/15 text-text-primary"
                      : "text-text-secondary hover:bg-surface-elevated"
                  } ${cmd.isIgnored ? "opacity-60" : ""}`}
                  title={cmd.isIgnored ? "Gitignored file" : undefined}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{cmd.label}</span>
                  {cmd.hint && (
                    <span className="ml-auto flex items-center gap-1.5 text-xs text-text-subtle truncate max-w-[200px]">
                      {cmd.connectionColor && (
                        <span
                          className="shrink-0 size-2 rounded-full"
                          style={{ backgroundColor: cmd.connectionColor }}
                        />
                      )}
                      {cmd.hint}
                    </span>
                  )}
                  {cmd.shortcut && (
                    <kbd className="ml-auto shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle font-mono">
                      {cmd.shortcut}
                    </kbd>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Shortcut hint */}
        <div className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-1.5">
          <span className="text-[10px] text-text-subtle">Press</span>
          <kbd className="inline-flex items-center rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-text-subtle font-mono">
            Shift
          </kbd>
          <kbd className="inline-flex items-center rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-text-subtle font-mono">
            Shift
          </kbd>
          <span className="text-[10px] text-text-subtle">to open this palette</span>
        </div>
      </div>
    </div>
    </>
  );
}
