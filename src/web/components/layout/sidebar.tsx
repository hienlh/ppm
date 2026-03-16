import { useState, useMemo, useCallback } from "react";
import { FolderOpen, ChevronDown, Check, Plus, Search, Bug } from "lucide-react";
import { useProjectStore, sortByRecent } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { FileTree } from "@/components/explorer/file-tree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { openBugReport } from "@/lib/report-bug";

/** Max projects shown before needing to search (desktop) */
const MAX_VISIBLE = 8;

export function Sidebar() {
  const { projects, activeProject, setActiveProject, loading } =
    useProjectStore();
  const openTab = useTabStore((s) => s.openTab);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const version = useSettingsStore((s) => s.version);
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => sortByRecent(projects), [projects]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted.slice(0, MAX_VISIBLE);
    const q = query.toLowerCase();
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const showSearch = projects.length > MAX_VISIBLE || query.length > 0;

  function handleAddProject() {
    openTab({ type: "projects", title: "Projects", projectId: null, closable: true });
  }

  const handleReportBug = useCallback(() => openBugReport(version), [version]);

  return (
    <aside className="hidden md:flex flex-col w-[280px] min-w-[280px] bg-background border-r border-border overflow-hidden">
      {/* Logo + project dropdown — same height as tab bar */}
      <div className="flex items-center gap-2 px-3 h-[41px] border-b border-border shrink-0">
        <span className="text-sm font-bold text-primary tracking-tight shrink-0">PPM</span>
        {deviceName && (
          <span className="text-[10px] text-text-subtle bg-surface-elevated px-1.5 py-0.5 rounded-full truncate max-w-[100px]" title={deviceName}>
            {deviceName}
          </span>
        )}

        <DropdownMenu onOpenChange={() => setQuery("")}>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-surface-elevated transition-colors min-w-0 flex-1">
              <FolderOpen className="size-3.5 text-text-subtle shrink-0" />
              <span className="text-sm truncate flex-1 text-left">
                {activeProject?.name ?? "Select Project"}
              </span>
              <ChevronDown className="size-3 text-text-subtle shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[360px] p-0">
            {/* Search — only when many projects */}
            {showSearch && (
              <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
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
            <div className="max-h-64 overflow-y-auto py-1">
              {loading && (
                <p className="px-3 py-1.5 text-xs text-text-secondary">Loading...</p>
              )}
              {!loading && filtered.length === 0 && (
                <p className="px-3 py-2 text-xs text-text-subtle text-center">
                  {query ? "No matches" : "No projects"}
                </p>
              )}
              {filtered.map((project) => (
                <button
                  key={project.name}
                  onClick={() => setActiveProject(project)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors hover:bg-surface-elevated",
                    activeProject?.name === project.name && "bg-accent/10",
                  )}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-text-subtle" />
                  <span className="truncate font-semibold text-text-primary">{project.name}</span>
                  <span className="truncate text-xs text-text-subtle ml-auto">{project.path}</span>
                  {activeProject?.name === project.name && (
                    <Check className="size-3.5 text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>

            <DropdownMenuSeparator className="my-0" />
            <button
              onClick={handleAddProject}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:bg-surface-elevated transition-colors"
            >
              <Plus className="size-3.5 shrink-0" />
              <span>Add Project...</span>
            </button>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* File tree */}
      {activeProject ? (
        <div className="flex-1 overflow-y-auto">
          <FileTree />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-xs text-text-subtle text-center">
            Select a project to browse files
          </p>
        </div>
      )}

      {/* Version footer + Report Bug */}
      {version && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border shrink-0">
          <span className="text-[10px] text-text-subtle">v{version}</span>
          <button
            onClick={handleReportBug}
            title="Report a bug"
            className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
          >
            <Bug className="size-3" />
            <span>Report Bug</span>
          </button>
        </div>
      )}
    </aside>
  );
}
