import { useState, useEffect, useRef, useMemo } from "react";
import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  Settings,
  Search,
  FileCode,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useProjectStore } from "@/stores/project-store";
import { useFileStore, type FileNode } from "@/stores/file-store";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ElementType;
  action: () => void;
  keywords?: string;
  group: "action" | "file";
}

/** Recursively flatten file tree into file-only list */
function flattenFiles(nodes: FileNode[], prefix = ""): { name: string; path: string }[] {
  const result: { name: string; path: string }[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      result.push({ name: node.name, path: node.path });
    }
    if (node.children) {
      result.push(...flattenFiles(node.children, node.path));
    }
  }
  return result;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openTab = useTabStore((s) => s.openTab);
  const activeProject = useProjectStore((s) => s.activeProject);
  const fileTree = useFileStore((s) => s.tree);

  // Action commands
  const actionCommands = useMemo<CommandItem[]>(() => {
    const projectId = activeProject?.name ?? null;
    const meta = activeProject ? { projectName: activeProject.name } : undefined;

    const openNewTab = (type: TabType, title: string) => () => {
      openTab({ type, title, projectId, metadata: meta, closable: true });
      onClose();
    };

    return [
      { id: "terminal", label: "New Terminal", icon: Terminal, action: openNewTab("terminal", "Terminal"), keywords: "bash shell console", group: "action" },
      { id: "chat", label: "New AI Chat", icon: MessageSquare, action: openNewTab("chat", "AI Chat"), keywords: "ai assistant claude", group: "action" },
      { id: "git-graph", label: "Git Graph", icon: GitBranch, action: openNewTab("git-graph", "Git Graph"), keywords: "branch history log", group: "action" },
      { id: "git-status", label: "Git Status", icon: GitCommitHorizontal, action: openNewTab("git-status", "Git Status"), keywords: "changes diff staged", group: "action" },
      { id: "projects", label: "Projects", icon: FolderOpen, action: openNewTab("projects", "Projects"), keywords: "open switch", group: "action" },
      { id: "settings", label: "Settings", icon: Settings, action: openNewTab("settings", "Settings"), keywords: "config preferences", group: "action" },
    ];
  }, [activeProject, openTab, onClose]);

  // File commands — derived from file store tree
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

  const allCommands = useMemo(() => [...actionCommands, ...fileCommands], [actionCommands, fileCommands]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actionCommands; // show only actions when empty
    const q = query.toLowerCase();
    // Fuzzy-ish: every character of query must appear in order
    const matchesFuzzy = (text: string) => {
      let ti = 0;
      for (let qi = 0; qi < q.length; qi++) {
        ti = text.indexOf(q[qi]!, ti);
        if (ti === -1) return false;
        ti++;
      }
      return true;
    };
    return allCommands.filter(
      (c) => matchesFuzzy(c.label.toLowerCase()) || (c.keywords && matchesFuzzy(c.keywords.toLowerCase())),
    );
  }, [allCommands, actionCommands, query]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
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

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIdx((i) => (i + 1) % filtered.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx((i) => (i - 1 + filtered.length) % filtered.length);
        break;
      case "Enter":
        e.preventDefault();
        filtered[selectedIdx]?.action();
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div
        className="relative z-10 w-full max-w-md rounded-lg border border-border bg-background shadow-2xl overflow-hidden"
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
            placeholder="Search actions & files..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-sm text-text-subtle text-center">No results</p>
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
                    <span className="ml-auto text-xs text-text-subtle truncate max-w-[200px]">
                      {cmd.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
