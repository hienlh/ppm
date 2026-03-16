import { useEffect, useState, useCallback } from "react";
import { FolderOpen, GitBranch, Circle, Plus, Pencil, Trash2 } from "lucide-react";
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
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DirSuggest } from "./dir-suggest";
import type { ProjectInfo } from "@/stores/project-store";

export function ProjectList() {
  const { projects, activeProject, setActiveProject, fetchProjects, loading, error } =
    useProjectStore();
  const openTab = useTabStore((s) => s.openTab);

  // Add dialog state
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");

  // Edit dialog state
  const [editTarget, setEditTarget] = useState<ProjectInfo | null>(null);
  const [editName, setEditName] = useState("");
  const [editPath, setEditPath] = useState("");
  const [editError, setEditError] = useState("");

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<ProjectInfo | null>(null);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  function handleClick(project: ProjectInfo) {
    setActiveProject(project);
  }

  function handleOpen(project: ProjectInfo) {
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

  function openEdit(project: ProjectInfo, e: React.MouseEvent) {
    e.stopPropagation();
    setEditTarget(project);
    setEditName(project.name);
    setEditPath(project.path);
    setEditError("");
  }

  const handleEditProject = useCallback(async () => {
    if (!editTarget || !editName.trim()) return;
    setEditError("");
    try {
      await api.patch(`/api/projects/${encodeURIComponent(editTarget.name)}`, {
        name: editName.trim(),
        path: editPath.trim() || undefined,
      });
      await fetchProjects();
      // Update active project if it was the one edited
      if (activeProject?.name === editTarget.name) {
        const updated = useProjectStore.getState().projects
          .find((p) => p.name === editName.trim());
        if (updated) setActiveProject(updated);
      }
      setEditTarget(null);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to update project");
    }
  }, [editTarget, editName, editPath, fetchProjects, activeProject, setActiveProject]);

  function openDelete(project: ProjectInfo, e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteTarget(project);
    setDeleteError("");
  }

  const handleDeleteProject = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    try {
      await api.del(`/api/projects/${encodeURIComponent(deleteTarget.name)}`);
      // Clear active project if it was deleted
      if (activeProject?.name === deleteTarget.name) {
        const remaining = projects.filter((p) => p.name !== deleteTarget.name);
        if (remaining.length > 0) {
          setActiveProject(remaining[0]!);
        }
      }
      await fetchProjects();
      setDeleteTarget(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete project");
    }
  }, [deleteTarget, activeProject, projects, fetchProjects, setActiveProject]);

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
              "group text-left p-4 rounded-lg border transition-colors relative",
              "min-h-[44px]",
              activeProject?.name === project.name
                ? "bg-surface border-primary"
                : "bg-surface border-border hover:border-text-subtle",
            )}
          >
            {/* Action buttons */}
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => openEdit(project, e)}
                className="p-1.5 rounded-md hover:bg-surface-elevated text-text-subtle hover:text-text-primary transition-colors"
                title="Edit project"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                onClick={(e) => openDelete(project, e)}
                className="p-1.5 rounded-md hover:bg-error/10 text-text-subtle hover:text-error transition-colors"
                title="Remove project"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>

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
              <DirSuggest
                value={addPath}
                onChange={setAddPath}
                onSelect={(item) => {
                  if (!addName.trim()) setAddName(item.name);
                }}
                placeholder="/home/user/my-project"
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

      {/* Edit Project Dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-text-secondary">Name</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleEditProject()}
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm text-text-secondary">Path</label>
              <DirSuggest
                value={editPath}
                onChange={setEditPath}
                placeholder="/home/user/my-project"
              />
            </div>
            {editError && (
              <p className="text-sm text-error">{editError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleEditProject} disabled={!editName.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Project</DialogTitle>
            <DialogDescription>
              Remove <strong>{deleteTarget?.name}</strong> from PPM? This only unregisters
              it — project files on disk are not affected.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-error">{deleteError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteProject}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
