import { useEffect } from "react";
import { FolderTree, ChevronRight } from "lucide-react";
import { useProjectStore } from "../../stores/project.store";
import { useSettingsStore } from "../../stores/settings.store";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { FileTreeLoader } from "../explorer/file-tree-loader";

function ProjectsSidebarContent() {
  const { projects, activeProject, loading, fetchProjects, setActiveProject } =
    useProjectStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  if (loading) {
    return (
      <div className="flex flex-col gap-1 p-2">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="h-8 rounded bg-muted/60 animate-pulse"
            style={{ opacity: 1 - i * 0.2 }}
          />
        ))}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-muted-foreground text-xs px-4 text-center">
        No projects found.
        <br />
        Run <code className="font-mono">ppm add .</code> to register one.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {projects.map((p) => (
        <button
          key={p.path}
          onClick={() => setActiveProject(p)}
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors w-full",
            activeProject?.path === p.path
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted text-foreground",
          )}
        >
          <FolderTree className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate flex-1">{p.name}</span>
          {p.hasGit && (
            <span className="text-[10px] text-muted-foreground font-mono">
              git
            </span>
          )}
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}


export function Sidebar() {
  const { sidebarOpen } = useSettingsStore();
  const { activeProject } = useProjectStore();

  if (!sidebarOpen) return null;

  return (
    <aside className="hidden md:flex flex-col w-[280px] shrink-0 border-r border-border bg-sidebar h-full">
      <div className="flex items-center h-9 px-3 border-b border-sidebar-border shrink-0">
        <span className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider">
          {activeProject ? activeProject.name : "Projects"}
        </span>
      </div>
      <ScrollArea className="flex-1">
        {activeProject ? (
          <FileTreeLoader projectName={activeProject.name} projectPath={activeProject.path} />
        ) : (
          <ProjectsSidebarContent />
        )}
      </ScrollArea>
    </aside>
  );
}
