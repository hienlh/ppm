import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  Settings,
  Database,
  Search,
  FileCode,
  FilePlus,
  FolderOpen,
  Loader2,
  Globe,
  Mic,
  Puzzle,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { useFileStore, type FileNode } from "@/stores/file-store";
import { useExtensionStore } from "@/stores/extension-store";
import { api } from "@/lib/api-client";
import { basename } from "@/lib/utils";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ElementType;
  action: () => void;
  keywords?: string;
  group: "action" | "file" | "fs" | "db";
  connectionColor?: string | null;
  shortcut?: string;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Format a keybinding combo for display (e.g. "Mod+G" → "⌘G" on Mac, "Ctrl+G" on others) */
function formatShortcut(combo: string): string {
  if (!combo) return "";
  return combo
    .replace(/Mod\+/g, isMac ? "⌘" : "Ctrl+")
    .replace(/Alt\+/g, isMac ? "⌥" : "Alt+")
    .replace(/Shift\+/g, isMac ? "⇧" : "Shift+")
    .replace(/Meta\+/g, "⌘")
    .replace(/Ctrl\+/g, isMac ? "⌃" : "Ctrl+");
}

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
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [fsFiles, setFsFiles] = useState<string[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [dbResults, setDbResults] = useState<DbSearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openTab = useTabStore((s) => s.openTab);
  const activeProject = useProjectStore((s) => s.activeProject);
  const fileTree = useFileStore((s) => s.tree);
  const setSidebarActiveTab = useSettingsStore((s) => s.setSidebarActiveTab);
  const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettingsStore((s) => s.toggleSidebar);
  const getBinding = useKeybindingsStore((s) => s.getBinding);
  const extContributions = useExtensionStore((s) => s.contributions);

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
    if (!isPathQuery(query)) {
      setFsFiles([]);
      return;
    }
    const dir = extractDir(query);
    fetchFsFiles(dir);
  }, [query, fetchFsFiles]);

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

  // Action commands
  const actionCommands = useMemo<CommandItem[]>(() => {
    const projectId = activeProject?.name ?? null;
    const meta = activeProject ? { projectName: activeProject.name } : undefined;

    const openNewTab = (type: TabType, title: string) => () => {
      openTab({ type, title, projectId, metadata: meta, closable: true });
      onClose();
    };

    const builtIn: CommandItem[] = [
      { id: "chat", label: "New AI Chat", icon: MessageSquare, action: openNewTab("chat", "AI Chat"), keywords: "ai assistant claude", group: "action", shortcut: formatShortcut(getBinding("open-chat")) },
      { id: "new-file", label: "New File", icon: FilePlus, action: () => { useTabStore.getState().openNewFile(); onClose(); }, keywords: "create untitled blank empty", group: "action", shortcut: formatShortcut(getBinding("new-file")) },
      { id: "terminal", label: "New Terminal", icon: Terminal, action: openNewTab("terminal", "Terminal"), keywords: "bash shell console", group: "action", shortcut: formatShortcut(getBinding("open-terminal")) },
      { id: "git-graph", label: "Git Graph", icon: GitBranch, action: openNewTab("git-graph", "Git Graph"), keywords: "branch history log", group: "action", shortcut: formatShortcut(getBinding("open-git-graph")) },
      { id: "ports", label: "Port Forwarding", icon: Globe, action: openNewTab("ports", "Ports"), keywords: "web preview localhost port forward tunnel url", group: "action" },
      { id: "postgres", label: "PostgreSQL", icon: Database, action: openNewTab("postgres", "PostgreSQL"), keywords: "database pg sql query", group: "action" },
      { id: "voice-input", label: "Voice Input", icon: Mic, action: () => { window.dispatchEvent(new CustomEvent("toggle-voice-input")); onClose(); }, keywords: "speech microphone dictate voice", group: "action", shortcut: formatShortcut(getBinding("voice-input")) },
      { id: "git-status", label: "Git Status", icon: GitCommitHorizontal, action: () => { setSidebarActiveTab("git"); onClose(); }, keywords: "changes diff staged", group: "action", shortcut: formatShortcut(getBinding("open-git-status")) },
      {
        id: "settings", label: "Settings", icon: Settings,
        action: () => {
          if (sidebarCollapsed) toggleSidebar();
          setSidebarActiveTab("settings");
          onClose();
        },
        keywords: "config preferences theme",
        group: "action",
        shortcut: formatShortcut(getBinding("open-settings")),
      },
    ];

    // Append extension-contributed commands
    const extCmds: CommandItem[] = (extContributions?.commands ?? []).map((cmd) => ({
      id: `ext:${cmd.command}`,
      label: cmd.title,
      hint: cmd.category,
      icon: Puzzle,
      group: "action" as const,
      keywords: `extension ${cmd.command} ${cmd.category ?? ""}`,
      action: () => {
        // Phase 4: execute via WS bridge
        console.log("[CmdPalette] ext command:", cmd.command);
        onClose();
      },
    }));

    return [...builtIn, ...extCmds];
  }, [activeProject, openTab, onClose, setSidebarActiveTab, sidebarCollapsed, toggleSidebar, getBinding, extContributions]);

  // File commands — derived from file store tree (project files)
  const fileCommands = useMemo<CommandItem[]>(() => {
    const projectId = activeProject?.name ?? null;
    const meta = activeProject ? { projectName: activeProject.name } : undefined;
    const files = flattenFiles(fileTree);

    return files.map((f) => ({
      id: `file:${f.path}`,
      label: f.name,
      hint: f.path,
      icon: FileCode,
      group: "file" as const,
      keywords: f.path,
      action: () => {
        openTab({
          type: "editor",
          title: f.name,
          projectId,
          metadata: { ...meta, filePath: f.path },
          closable: true,
        });
        onClose();
      },
    }));
  }, [fileTree, activeProject, openTab, onClose]);

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
        action: () => {
          openTab({
            type: "editor",
            title: name,
            projectId,
            metadata: { ...meta, filePath: fp },
            closable: true,
          });
          onClose();
        },
      };
    });
  }, [fsFiles, activeProject, openTab, onClose]);

  const dbCommands = useMemo<CommandItem[]>(() => dbResults.map((r) => ({
    id: `db:${r.connectionId}:${r.schemaName}.${r.tableName}`,
    label: r.tableName,
    hint: `${r.connectionName} (${r.connectionType === "postgres" ? "PG" : "SQLite"})`,
    icon: Database,
    group: "db" as const,
    connectionColor: r.connectionColor,
    action: () => {
      openTab({
        type: "database",
        title: `${r.connectionName} · ${r.tableName}`,
        projectId: null,
        closable: true,
        metadata: { connectionId: r.connectionId, connectionName: r.connectionName, dbType: r.connectionType, tableName: r.tableName, schemaName: r.schemaName, connectionColor: r.connectionColor },
      });
      onClose();
    },
  })), [dbResults, openTab, onClose]);

  const allCommands = useMemo(
    () => [...actionCommands, ...fileCommands],
    [actionCommands, fileCommands],
  );

  const filtered = useMemo(() => {
    // Path mode — search filesystem results using filename portion only
    if (isPathQuery(query)) {
      const lastSlash = query.lastIndexOf("/");
      const fileFilter = lastSlash >= 0 ? query.slice(lastSlash + 1).toLowerCase() : "";
      if (!fileFilter) return fsCommands.slice(0, 50);
      return fsCommands.filter((c) => {
        const name = c.label.toLowerCase();
        const path = (c.keywords ?? "").toLowerCase();
        return name.includes(fileFilter) || path.includes(fileFilter);
      }).slice(0, 50);
    }

    // Normal mode
    if (!query.trim()) return actionCommands;
    const q = query.toLowerCase();
    const matchesFuzzy = (text: string) => {
      let ti = 0;
      for (let qi = 0; qi < q.length; qi++) {
        ti = text.indexOf(q[qi]!, ti);
        if (ti === -1) return false;
        ti++;
      }
      return true;
    };
    const matched = allCommands.filter(
      (c) => matchesFuzzy(c.label.toLowerCase()) || (c.keywords && matchesFuzzy(c.keywords.toLowerCase())),
    );
    // Prepend DB results (already filtered server-side) when query is 2+ chars
    return query.trim().length >= 2 ? [...dbCommands, ...matched] : matched;
  }, [allCommands, actionCommands, fsCommands, dbCommands, query]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery(initialQuery || "");
      setSelectedIdx(0);
      setFsFiles([]);
      setDbResults([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp selected index when filter changes
  useEffect(() => {
    setSelectedIdx((prev) => Math.min(prev, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

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
    const len = filtered.length;
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
          filtered[selectedIdx]?.action();
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

  if (!open) return null;

  const pathMode = isPathQuery(query);

  return (
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

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            fsLoading ? (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">Searching...</p>
            ) : query.trim() ? (
              <button
                onClick={askAi}
                className="flex items-center gap-3 w-full px-3 py-3 text-sm text-left text-text-secondary hover:bg-accent/15 hover:text-text-primary transition-colors"
              >
                <MessageSquare className="size-4 shrink-0 text-accent" />
                <span>Ask AI: <span className="text-text-primary font-medium">{query.trim().slice(0, 60)}</span></span>
              </button>
            ) : (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">No results</p>
            )
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  className={`flex items-center gap-3 w-full px-3 py-2 text-sm text-left transition-colors ${
                    i === selectedIdx
                      ? "bg-accent/15 text-text-primary"
                      : "text-text-secondary hover:bg-surface-elevated"
                  }`}
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
  );
}
