import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import {
  Folder, File, Database, Home, Monitor, FileText, FolderPlus, Trash2,
  Download, ChevronRight, ArrowLeft, Search, Loader2, Clock, Eye, EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────

interface BrowseEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified: string;
}

interface BrowseResult {
  entries: BrowseEntry[];
  current: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
}

export interface FileBrowserPickerProps {
  open: boolean;
  mode: "file" | "folder" | "both";
  accept?: string[];
  root?: string;
  title?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

// ── Helpers ────────────────────────────────────────────────────────

const RECENT_KEY = "ppm-recent-paths";
const MAX_RECENT = 5;

const QUICK_ACCESS = [
  { name: "Home", path: "~", icon: Home },
  { name: "Desktop", path: "~/Desktop", icon: Monitor },
  { name: "Documents", path: "~/Documents", icon: FileText },
  { name: "Downloads", path: "~/Downloads", icon: Download },
];

function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}

function saveRecent(dirPath: string): void {
  const updated = [dirPath, ...getRecent().filter((p) => p !== dirPath)].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fileIcon(entry: BrowseEntry): React.ReactNode {
  if (entry.type === "directory") return <Folder className="size-4 text-blue-500" />;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (ext && ["db", "sqlite", "sqlite3"].includes(ext)) return <Database className="size-4 text-amber-500" />;
  return <File className="size-4 text-text-subtle" />;
}

function matchesAccept(name: string, accept?: string[]): boolean {
  if (!accept?.length) return true;
  const ext = "." + name.split(".").pop()?.toLowerCase();
  return accept.includes(ext);
}

// ── Main Component ─────────────────────────────────────────────────

export function FileBrowserPicker({
  open, mode, accept, root, title, onSelect, onCancel,
}: FileBrowserPickerProps) {
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [current, setCurrent] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; path: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderError, setNewFolderError] = useState<string | null>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  const defaultTitle = mode === "folder" ? "Select Folder" : mode === "file" ? "Select File" : "Select File or Folder";

  const fetchDir = useCallback(async (dirPath?: string, hidden?: boolean) => {
    setLoading(true);
    setError(null);
    setSelected(null);
    setSearch("");
    try {
      const params = new URLSearchParams();
      if (dirPath) params.set("path", dirPath);
      if (hidden) params.set("showHidden", "true");
      const result = await api.get<BrowseResult>(`/api/fs/browse?${params}`);
      setEntries(result.entries);
      setCurrent(result.current);
      setParent(result.parent);
      setBreadcrumbs(result.breadcrumbs);
      setPathInput(result.current);
    } catch (e) {
      setError((e as Error).message || "Failed to browse directory");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on open
  useEffect(() => {
    if (open) {
      fetchDir(root ?? "~", showHidden);
      setRecentPaths(getRecent());
    }
  }, [open, root, fetchDir, showHidden]);

  const handleNavigate = (path: string) => fetchDir(path, showHidden);

  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    fetchDir(current || (root ?? "~"), next);
  };

  const handlePathInputSubmit = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && pathInput.trim()) {
      fetchDir(pathInput.trim());
    }
  };

  const handleEntryClick = (entry: BrowseEntry) => {
    if (entry.type === "directory") {
      if (mode === "file") {
        // In file mode, clicking a dir navigates into it
        handleNavigate(entry.path);
      } else {
        // In folder/both mode, clicking selects it
        setSelected(entry.path);
      }
    } else {
      // File: select if mode allows
      if (mode !== "folder") {
        setSelected(entry.path);
      }
    }
  };

  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === "directory") {
      handleNavigate(entry.path);
    }
  };

  const handleConfirm = () => {
    if (!selected) return;
    saveRecent(current);
    onSelect(selected);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName?.trim() || !current) return;
    const folderPath = `${current}/${newFolderName.trim()}`;
    setCreatingFolder(true);
    setNewFolderError(null);
    try {
      await api.post("/api/fs/mkdir", { path: folderPath });
      setNewFolderName(null);
      setNewFolderError(null);
      await fetchDir(current, showHidden);
      setSelected(folderPath);
    } catch (e) {
      setNewFolderError((e as Error).message || "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selected) return;
    const entry = entries.find((e) => e.path === selected);
    if (!entry || entry.type !== "directory") return;
    if (!window.confirm(`Delete folder "${entry.name}"? This cannot be undone.`)) return;
    try {
      await api.del("/api/fs/rmdir", { path: selected });
      setSelected(null);
      await fetchDir(current, showHidden);
    } catch (e) {
      setError((e as Error).message || "Failed to delete folder");
    }
  };

  const selectedIsFolder = selected ? entries.some((e) => e.path === selected && e.type === "directory") : false;

  // Filter entries by search + accept
  const visible = entries.filter((e) => {
    if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (e.type === "file" && accept?.length && !matchesAccept(e.name, accept)) return false;
    return true;
  });

  const isSelectable = (entry: BrowseEntry): boolean => {
    if (entry.type === "directory") return mode !== "file";
    return mode !== "folder";
  };

  const content = (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Path input bar */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
        {parent && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => handleNavigate(parent)}>
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <Input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={handlePathInputSubmit}
          placeholder="Type path and press Enter"
          className="h-7 text-xs font-mono flex-1"
        />
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border overflow-x-auto text-xs">
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.path} className="flex items-center shrink-0">
            {i > 0 && <ChevronRight className="size-3 text-text-subtle mx-0.5" />}
            <button
              type="button"
              onClick={() => handleNavigate(crumb.path)}
              className="hover:text-primary hover:underline text-text-secondary"
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      {/* Main area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Quick access sidebar (desktop only) */}
        {!isMobile && (
          <div className="w-36 border-r border-border py-2 px-1 shrink-0 overflow-y-auto">
            {QUICK_ACCESS.map((qa) => (
              <button
                key={qa.path}
                type="button"
                onClick={() => handleNavigate(qa.path)}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1 text-xs rounded-md hover:bg-surface-hover text-left",
                  current.endsWith(qa.name) && "bg-primary/10 text-primary",
                )}
              >
                <qa.icon className="size-3.5" />
                {qa.name}
              </button>
            ))}
            {recentPaths.length > 0 && (
              <>
                <div className="text-[10px] text-text-subtle px-2 mt-3 mb-1 font-medium">Recent</div>
                {recentPaths.map((rp) => (
                  <button
                    key={rp}
                    type="button"
                    onClick={() => handleNavigate(rp)}
                    className="flex items-center gap-2 w-full px-2 py-1 text-xs rounded-md hover:bg-surface-hover text-left truncate"
                  >
                    <Clock className="size-3 shrink-0" />
                    <span className="truncate">{rp.split("/").pop()}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Entry list */}
        <ScrollArea className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-text-subtle" />
            </div>
          ) : error ? (
            <div className="text-center py-8 text-xs text-red-500">{error}</div>
          ) : visible.length === 0 ? (
            <div className="text-center py-8 text-xs text-text-subtle">
              {search ? "No matching entries" : "Empty directory"}
            </div>
          ) : (
            <div ref={listRef} className="py-1">
              {newFolderName != null && (
                <>
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/5 border-b border-border">
                    <FolderPlus className="size-4 text-primary shrink-0" />
                    <Input
                      ref={newFolderInputRef}
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreateFolder();
                        if (e.key === "Escape") setNewFolderName(null);
                      }}
                      placeholder="Folder name"
                      className="h-6 text-xs flex-1"
                      disabled={creatingFolder}
                      autoFocus
                    />
                    {creatingFolder && <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />}
                  </div>
                  {newFolderError && (
                    <div className="px-3 py-1 text-[11px] text-destructive bg-destructive/5 border-b border-border">
                      {newFolderError}
                    </div>
                  )}
                </>
              )}
              {visible.map((entry) => {
                const selectable = isSelectable(entry);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => handleEntryClick(entry)}
                    onDoubleClick={() => handleEntryDoubleClick(entry)}
                    className={cn(
                      "flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs transition-colors",
                      selected === entry.path
                        ? "bg-primary/10 text-primary"
                        : selectable
                          ? "hover:bg-surface-hover text-text-primary"
                          : "opacity-40 cursor-default",
                    )}
                    disabled={!selectable && entry.type === "file"}
                  >
                    {fileIcon(entry)}
                    <span className={cn("flex-1 truncate", entry.type === "directory" && "font-medium")}>
                      {entry.name}
                    </span>
                    <span className="text-text-subtle text-[10px] shrink-0 w-14 text-right">
                      {formatSize(entry.size)}
                    </span>
                    <span className="text-text-subtle text-[10px] shrink-0 w-14 text-right">
                      {formatRelativeTime(entry.modified)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => {
            setNewFolderName("");
            setNewFolderError(null);
            setTimeout(() => newFolderInputRef.current?.focus(), 50);
          }}
          title="New Folder"
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-destructive/70 hover:text-destructive disabled:opacity-30"
          onClick={handleDeleteSelected}
          disabled={!selectedIsFolder}
          title="Delete selected folder"
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7 shrink-0", showHidden && "text-primary")}
          onClick={toggleHidden}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        </Button>
        {accept?.length ? (
          <span className="text-[10px] text-text-subtle bg-surface-hover px-1.5 py-0.5 rounded">
            {accept.join(", ")}
          </span>
        ) : null}
        <div className="flex-1 max-w-48">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-text-subtle" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="h-6 text-[11px] pl-6"
            />
          </div>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={onCancel} className="h-7 text-xs">
          Cancel
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={!selected} className="h-7 text-xs">
          Select
        </Button>
      </div>
    </div>
  );

  // Responsive: Dialog for desktop, simplified dialog with taller content for mobile
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className={cn(
        "p-0 gap-0 overflow-hidden flex flex-col",
        isMobile ? "max-w-[95vw] h-[85vh]" : "max-w-2xl h-[70vh]",
      )}>
        <DialogHeader className="px-3 py-2 border-b border-border">
          <DialogTitle className="text-sm">{title ?? defaultTitle}</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  );
}
