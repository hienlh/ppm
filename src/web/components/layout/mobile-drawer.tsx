import { useState, useMemo, useCallback } from "react";
import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  FileDiff,
  Settings,
  X,
  FileCode,
  ChevronDown,
  Check,
  Plus,
  Search,
  Bug,
} from "lucide-react";
import { useProjectStore, sortByRecent } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { FileTree } from "@/components/explorer/file-tree";
import { openBugReport } from "@/lib/report-bug";

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const TAB_ICONS: Record<TabType, React.ElementType> = {
  projects: FolderOpen,
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  "git-graph": GitBranch,
  "git-status": GitCommitHorizontal,
  "git-diff": FileDiff,
  settings: Settings,
};

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-status", label: "Git Status" },
  { type: "git-graph", label: "Git Graph" },
  { type: "settings", label: "Settings" },
];

/** Max projects shown before needing to search (mobile — larger items) */
const MAX_VISIBLE_MOBILE = 5;

export function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const { projects, activeProject, setActiveProject } = useProjectStore();
  const openTab = useTabStore((s) => s.openTab);
  const version = useSettingsStore((s) => s.version);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => sortByRecent(projects), [projects]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted.slice(0, MAX_VISIBLE_MOBILE);
    const q = query.toLowerCase();
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const showSearch = projects.length > MAX_VISIBLE_MOBILE || query.length > 0;

  function handleNewTab(type: TabType) {
    const needsProject =
      type === "git-graph" || type === "git-status" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject
      ? { projectName: activeProject?.name }
      : undefined;
    const label = NEW_TAB_OPTIONS.find((o) => o.type === type)?.label ?? type;
    openTab({ type, title: label, metadata, projectId: activeProject?.name ?? null, closable: true });
    onClose();
  }

  function handleSelectProject(project: typeof projects[number]) {
    setActiveProject(project);
    setProjectPickerOpen(false);
    setQuery("");
  }

  function handleTogglePicker() {
    setProjectPickerOpen((v) => !v);
    setQuery("");
  }

  const handleReportBug = useCallback(() => openBugReport(version), [version]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
        isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close drawer"
      />

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed left-0 top-0 bottom-0 w-[280px] bg-background border-r border-border",
          "z-50 flex flex-col transition-transform duration-300 ease-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header — logo + close */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-bold text-primary tracking-tight">PPM</span>
          <button
            onClick={onClose}
            className="flex items-center justify-center size-8 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* File tree — scrollable, takes remaining space */}
        <div className="flex-1 overflow-y-auto">
          {activeProject ? (
            <FileTree onFileOpen={onClose} />
          ) : (
            <p className="px-4 py-6 text-xs text-text-secondary text-center">
              Select a project below
            </p>
          )}
        </div>

        {/* Bottom section — actions within thumb reach */}
        <div className="shrink-0 border-t border-border">
          {/* New tab actions */}
          <div className="px-2 py-2 space-y-0.5">
            {NEW_TAB_OPTIONS.map((opt) => {
              const Icon = TAB_ICONS[opt.type];
              return (
                <button
                  key={opt.type}
                  onClick={() => handleNewTab(opt.type)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors min-h-[40px]"
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <Separator />

          {/* Project switcher — at very bottom for easy thumb access */}
          <div className="relative">
            <button
              onClick={handleTogglePicker}
              className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-surface-elevated transition-colors"
            >
              <FolderOpen className="size-4 text-primary shrink-0" />
              <span className="text-sm font-medium truncate flex-1">
                {activeProject?.name ?? "Select Project"}
              </span>
              <ChevronDown className={cn(
                "size-3.5 text-text-subtle shrink-0 transition-transform",
                projectPickerOpen && "rotate-180",
              )} />
            </button>

            {/* Project list popover — opens upward */}
            {projectPickerOpen && (
              <div className="absolute bottom-full left-0 right-0 bg-background border border-border rounded-t-lg shadow-lg overflow-hidden">
                {/* Search */}
                {showSearch && (
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                    <Search className="size-3.5 text-text-subtle shrink-0" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search projects..."
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-text-subtle text-text-primary"
                      autoFocus
                    />
                  </div>
                )}

                {/* Project list */}
                <div className="max-h-56 overflow-y-auto">
                  {filtered.map((project) => (
                    <button
                      key={project.name}
                      onClick={() => handleSelectProject(project)}
                      className={cn(
                        "w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors",
                        activeProject?.name === project.name
                          ? "bg-accent/10 text-text-primary"
                          : "text-text-secondary hover:bg-surface-elevated",
                      )}
                    >
                      <FolderOpen className="size-4 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{project.name}</p>
                        <p className="text-xs text-text-subtle truncate">{project.path}</p>
                      </div>
                      {activeProject?.name === project.name && (
                        <Check className="size-4 text-primary shrink-0" />
                      )}
                    </button>
                  ))}
                  {filtered.length === 0 && (
                    <p className="px-4 py-3 text-xs text-text-subtle text-center">
                      {query ? "No matches" : "No projects"}
                    </p>
                  )}
                </div>

                {/* Add project */}
                <button
                  onClick={() => {
                    setProjectPickerOpen(false);
                    openTab({ type: "projects", title: "Projects", projectId: null, closable: true });
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm text-text-secondary hover:bg-surface-elevated border-t border-border"
                >
                  <Plus className="size-4 shrink-0" />
                  <span>Add Project...</span>
                </button>
              </div>
            )}
          </div>

          {/* Report Bug + Version */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border">
            {version && <span className="text-[10px] text-text-subtle">v{version}</span>}
            <button
              onClick={handleReportBug}
              className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
            >
              <Bug className="size-3" />
              <span>Report Bug</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
