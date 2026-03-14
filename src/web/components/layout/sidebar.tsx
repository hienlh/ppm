import { FolderOpen, ChevronRight, ChevronDown } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { FileTree } from "@/components/explorer/file-tree";
import { Separator } from "@/components/ui/separator";
import { useState } from "react";

export function Sidebar() {
  const { projects, activeProject, setActiveProject, loading } =
    useProjectStore();
  const openTab = useTabStore((s) => s.openTab);
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  function handleProjectClick(project: (typeof projects)[number]) {
    setActiveProject(project);
  }

  return (
    <aside className="hidden md:flex flex-col w-[280px] min-w-[280px] bg-background border-r border-border overflow-y-auto">
      {/* Projects section header */}
      <button
        onClick={() => setProjectsExpanded(!projectsExpanded)}
        className="flex items-center gap-2 px-4 py-3 border-b border-border hover:bg-surface-elevated transition-colors"
      >
        {projectsExpanded ? (
          <ChevronDown className="size-3.5 text-text-subtle" />
        ) : (
          <ChevronRight className="size-3.5 text-text-subtle" />
        )}
        <FolderOpen className="size-4 text-primary" />
        <span className="text-sm font-semibold">Projects</span>
      </button>

      {/* Projects list (collapsible) */}
      {projectsExpanded && (
        <div className="p-2 space-y-1">
          {loading && (
            <p className="px-2 py-1 text-xs text-text-secondary">Loading...</p>
          )}

          {!loading && projects.length === 0 && (
            <p className="px-2 py-1 text-xs text-text-secondary">
              No projects found. Register one via CLI.
            </p>
          )}

          {projects.map((project) => (
            <button
              key={project.name}
              onClick={() => handleProjectClick(project)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors text-left",
                "min-h-[44px]",
                activeProject?.name === project.name
                  ? "bg-surface text-foreground"
                  : "text-text-secondary hover:bg-surface-elevated hover:text-foreground",
              )}
            >
              <FolderOpen className="size-4 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="truncate font-medium">{project.name}</p>
                <p className="truncate text-xs text-text-subtle">
                  {project.path}
                </p>
              </div>
              {project.branch && (
                <span className="text-xs text-primary shrink-0">
                  {project.branch}
                </span>
              )}
              <ChevronRight className="size-3 text-text-subtle shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* File tree section */}
      {activeProject && (
        <>
          <Separator />
          <div className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Files
          </div>
          <FileTree />
        </>
      )}
    </aside>
  );
}
