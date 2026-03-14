import { useEffect, useState, useCallback } from "react";
import { FolderOpen, GitBranch, Circle, Plus } from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ProjectList() {
  const { projects, activeProject, setActiveProject, fetchProjects, loading, error } =
    useProjectStore();
  const openTab = useTabStore((s) => s.openTab);
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  function handleClick(project: (typeof projects)[number]) {
    setActiveProject(project);
  }

  function handleOpen(project: (typeof projects)[number]) {
    setActiveProject(project);
    openTab({
      type: "terminal",
      title: `Terminal - ${project.name}`,
      metadata: { projectName: project.name },
      projectId: project.name,
      closable: true,
    });
  }

  const handleAddProject = useCallback(async () => {
    if (!addPath.trim()) return;
    setAddError("");
    try {
      await api.post("/api/projects", {
        path: addPath.trim(),
        name: addName.trim() || undefined,
      });
      await fetchProjects();
      setShowAdd(false);
      setAddPath("");
      setAddName("");
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add project");
    }
  }, [addPath, addName, fetchProjects]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-error text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="h-full p-4 space-y-4 overflow-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAdd(true)}
          className="gap-1.5"
        >
          <Plus className="size-4" />
          Add Project
        </Button>
      </div>

      {loading && (
        <p className="text-text-secondary text-sm">Loading projects...</p>
      )}

      {!loading && projects.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <FolderOpen className="size-10 mx-auto text-text-subtle" />
          <p className="text-text-secondary text-sm">No projects registered</p>
          <p className="text-text-subtle text-xs">
            Click "Add Project" or use <code className="font-mono bg-surface-elevated px-1 py-0.5 rounded">ppm projects add &lt;path&gt;</code>
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <button
            key={project.name}
            onClick={() => handleClick(project)}
            onDoubleClick={() => handleOpen(project)}
            className={cn(
              "text-left p-4 rounded-lg border transition-colors",
              "min-h-[44px]",
              activeProject?.name === project.name
                ? "bg-surface border-primary"
                : "bg-surface border-border hover:border-text-subtle",
            )}
          >
            <div className="flex items-start gap-3">
              <FolderOpen className="size-5 text-primary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="font-medium truncate">{project.name}</p>
                <p className="text-xs text-text-secondary truncate">
                  {project.path}
                </p>
                {project.branch && (
                  <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <GitBranch className="size-3" />
                    <span>{project.branch}</span>
                    {project.status && (
                      <Circle
                        className={cn(
                          "size-2 fill-current",
                          project.status === "clean"
                            ? "text-success"
                            : "text-warning",
                        )}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Add Project Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-text-secondary">Path (required)</label>
              <Input
                placeholder="/home/user/my-project"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm text-text-secondary">Name (optional)</label>
              <Input
                placeholder="Auto-detected from folder name"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
              />
            </div>
            {addError && (
              <p className="text-sm text-error">{addError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddProject} disabled={!addPath.trim()}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
