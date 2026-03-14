import { FolderOpen, GitBranch } from "lucide-react";
import type { ProjectInfo } from "../../../types/project";
import { cn } from "../../lib/utils";

interface ProjectCardProps {
  project: ProjectInfo;
  active?: boolean;
  onClick(): void;
}

export function ProjectCard({ project, active, onClick }: ProjectCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors",
        active
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border bg-card hover:bg-accent text-foreground",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center size-8 rounded-md shrink-0",
          active ? "bg-primary/10" : "bg-muted",
        )}
      >
        <FolderOpen className="size-4 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{project.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {project.path}
        </div>
      </div>

      {project.hasGit && (
        <div className="flex items-center gap-1 shrink-0 text-xs text-muted-foreground">
          <GitBranch className="size-3" />
          <span>git</span>
        </div>
      )}
    </button>
  );
}
