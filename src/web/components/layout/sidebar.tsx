import { FolderOpen, ChevronDown, Check } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";
import { FileTree } from "@/components/explorer/file-tree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Sidebar() {
  const { projects, activeProject, setActiveProject, loading } =
    useProjectStore();

  return (
    <aside className="hidden md:flex flex-col w-[280px] min-w-[280px] bg-background border-r border-border overflow-hidden">
      {/* Project switcher dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 px-4 py-3 border-b border-border hover:bg-surface-elevated transition-colors w-full text-left">
            <FolderOpen className="size-4 text-primary shrink-0" />
            <span className="text-sm font-semibold truncate flex-1">
              {activeProject?.name ?? "Select Project"}
            </span>
            <ChevronDown className="size-3.5 text-text-subtle shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[260px]">
          {loading && (
            <p className="px-2 py-1.5 text-xs text-text-secondary">Loading...</p>
          )}
          {!loading && projects.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-text-secondary">
              No projects found
            </p>
          )}
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.name}
              onClick={() => setActiveProject(project)}
              className="flex items-center gap-2"
            >
              <FolderOpen className="size-4 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm">{project.name}</p>
                <p className="truncate text-xs text-text-subtle">{project.path}</p>
              </div>
              {activeProject?.name === project.name && (
                <Check className="size-4 text-primary shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* File tree — takes all remaining space */}
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
    </aside>
  );
}
