import {
  FolderOpen,
  ChevronRight,
  X,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { FileTree } from "@/components/explorer/file-tree";

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Mobile sidebar overlay drawer.
 * [V2 FIX] NOT a hidden/flex toggle — fixed overlay with backdrop.
 * Includes project list + file tree + quick git actions.
 */
export function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const { projects, activeProject, setActiveProject, loading } =
    useProjectStore();
  const openTab = useTabStore((s) => s.openTab);

  function handleProjectClick(project: (typeof projects)[number]) {
    setActiveProject(project);
  }

  function openGitStatus() {
    openTab({
      type: "git-status",
      title: "Git Status",
      metadata: { projectName: activeProject?.name },
      closable: true,
    });
    onClose();
  }

  function openGitGraph() {
    openTab({
      type: "git-graph",
      title: "Git Graph",
      metadata: { projectName: activeProject?.name },
      closable: true,
    });
    onClose();
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
        isOpen
          ? "opacity-100"
          : "opacity-0 pointer-events-none",
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
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-primary" />
            <span className="text-sm font-semibold">Projects</span>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center size-8 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Projects list */}
          <div className="p-2 space-y-1">
            {loading && (
              <p className="px-2 py-1 text-xs text-text-secondary">
                Loading...
              </p>
            )}

            {!loading && projects.length === 0 && (
              <p className="px-2 py-1 text-xs text-text-secondary">
                No projects found.
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

          {/* Git quick actions */}
          {activeProject && (
            <>
              <Separator className="my-1" />
              <div className="px-2 space-y-1">
                <button
                  onClick={openGitStatus}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors min-h-[44px]"
                >
                  <GitCommitHorizontal className="size-4 shrink-0" />
                  <span>Git Status</span>
                </button>
                <button
                  onClick={openGitGraph}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors min-h-[44px]"
                >
                  <GitBranch className="size-4 shrink-0" />
                  <span>Git Graph</span>
                </button>
              </div>
            </>
          )}

          {/* File tree */}
          {activeProject && (
            <>
              <Separator className="my-1" />
              <div className="px-4 py-2 text-xs font-semibold text-text-secondary uppercase tracking-wider">
                Files
              </div>
              <FileTree onFileOpen={onClose} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
