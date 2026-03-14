import { useEffect } from "react";
import { Loader2, FolderX } from "lucide-react";
import { useProjectStore } from "../../stores/project.store";
import { ProjectCard } from "./project-card";
import { ScrollArea } from "../ui/scroll-area";

export function ProjectList() {
  const { projects, activeProject, loading, fetchProjects, setActiveProject } =
    useProjectStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-muted-foreground px-6 text-center">
        <FolderX className="size-12 opacity-30" />
        <div>
          <p className="font-medium text-sm">No projects yet</p>
          <p className="text-xs mt-1">
            Run <code className="font-mono bg-muted px-1 rounded">ppm add .</code>{" "}
            in a directory to register it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
          Projects ({projects.length})
        </h2>
        {projects.map((project) => (
          <ProjectCard
            key={project.path}
            project={project}
            active={activeProject?.path === project.path}
            onClick={() => setActiveProject(project)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
