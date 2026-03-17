import { useState, useCallback } from "react";
import { Plus, Settings, ChevronUp, ChevronDown, Pencil, Trash2, Palette, Bug } from "lucide-react";
import { openBugReportPopup } from "@/lib/report-bug";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveProjectColor, PROJECT_PALETTE } from "@/lib/project-palette";
import { getProjectInitials } from "@/lib/project-avatar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { AddProjectForm } from "@/components/layout/add-project-form";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Avatar circle
// ---------------------------------------------------------------------------
function ProjectAvatar({ name, color, active, allNames }: {
  name: string; color: string; active: boolean; allNames: string[];
}) {
  const initials = getProjectInitials(name, allNames);
  return (
    <div
      className={cn(
        "size-10 rounded-full flex items-center justify-center text-xs font-bold text-white select-none shrink-0",
        active && "ring-2 ring-primary ring-offset-2 ring-offset-background",
      )}
      style={{ background: color }}
    >
      {initials}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Color picker popover (inline in dialog)
// ---------------------------------------------------------------------------
function ColorPicker({ current, onChange }: { current: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {PROJECT_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "size-8 rounded-full border-2 transition-all",
            current === c ? "border-primary scale-110" : "border-transparent hover:scale-105",
          )}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectBar
// ---------------------------------------------------------------------------
export function ProjectBar() {
  const { projects, activeProject, setActiveProject, setProjectColor, moveProject, renameProject, deleteProject, customOrder } = useProjectStore();
  const openTab = useTabStore((s) => s.openTab);
  const version = useSettingsStore((s) => s.version);
  const handleReportBug = useCallback(() => openBugReportPopup(version), [version]);

  const ordered = resolveOrder(projects, customOrder);
  const allNames = ordered.map((p) => p.name);

  // Rename dialog
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState("");
  const [renameValue, setRenameValue] = useState("");

  // Delete confirm dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState("");

  // Add project dialog
  const [addOpen, setAddOpen] = useState(false);

  // Color picker dialog
  const [colorOpen, setColorOpen] = useState(false);
  const [colorTarget, setColorTarget] = useState("");
  const [colorValue, setColorValue] = useState("");
  const [colorSaving, setColorSaving] = useState(false);

  const openRename = useCallback((name: string) => {
    setRenameTarget(name);
    setRenameValue(name);
    setRenameOpen(true);
  }, []);

  const openDelete = useCallback((name: string) => {
    setDeleteTarget(name);
    setDeleteOpen(true);
  }, []);

  const openColor = useCallback((name: string, currentColor: string) => {
    setColorTarget(name);
    setColorValue(currentColor);
    setColorOpen(true);
  }, []);

  async function handleRename() {
    if (!renameValue.trim() || renameValue === renameTarget) { setRenameOpen(false); return; }
    try { await renameProject(renameTarget, renameValue.trim()); } catch { /* ignore */ }
    setRenameOpen(false);
  }

  async function handleDelete() {
    try { await deleteProject(deleteTarget); } catch { /* ignore */ }
    setDeleteOpen(false);
  }

  async function handleColorSave() {
    setColorSaving(true);
    try {
      await setProjectColor(colorTarget, colorValue);
      setColorOpen(false);
    } catch (e) {
      console.error("Failed to save color:", e);
    } finally {
      setColorSaving(false);
    }
  }

  function handleAddProject() {
    setAddOpen(true);
  }

  function handleSettings() {
    const { sidebarCollapsed, toggleSidebar, setSidebarActiveTab } = useSettingsStore.getState();
    if (sidebarCollapsed) toggleSidebar();
    setSidebarActiveTab("settings");
  }

  return (
    <aside className="hidden md:flex flex-col w-[52px] min-w-[52px] bg-background border-r border-border overflow-hidden">
      {/* Logo + version */}
      <div className="shrink-0 flex flex-col items-center justify-center h-[41px] border-b border-border gap-0.5">
        <span className="text-[11px] font-bold text-primary leading-none">PPM</span>
        {version && (
          <span className="text-[8px] text-text-subtle leading-none">v{version}</span>
        )}
      </div>

      {/* Project avatar list */}
      <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-2 min-h-0">
        {ordered.map((project, idx) => {
          const color = resolveProjectColor(project.color, idx);
          const isActive = activeProject?.name === project.name;
          return (
            <ContextMenu key={project.name}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ContextMenuTrigger asChild>
                    <button
                      onClick={() => setActiveProject(project)}
                      className="p-1 rounded-lg hover:bg-surface-elevated transition-colors"
                    >
                      <ProjectAvatar name={project.name} color={color} active={isActive} allNames={allNames} />
                    </button>
                  </ContextMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[200px]">
                  <p className="font-medium">{project.name}</p>
                  <p className="text-xs text-text-subtle truncate">{project.path}</p>
                </TooltipContent>
              </Tooltip>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => openRename(project.name)}>
                  <Pencil className="size-3.5 mr-2" /> Rename
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openColor(project.name, color)}>
                  <Palette className="size-3.5 mr-2" /> Change Color
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  disabled={idx === 0}
                  onClick={() => moveProject(project.name, "up")}
                >
                  <ChevronUp className="size-3.5 mr-2" /> Move Up
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={idx === ordered.length - 1}
                  onClick={() => moveProject(project.name, "down")}
                >
                  <ChevronDown className="size-3.5 mr-2" /> Move Down
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => openDelete(project.name)}
                >
                  <Trash2 className="size-3.5 mr-2" /> Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        {/* Add project button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleAddProject}
              className="size-10 rounded-full border-2 border-dashed border-border flex items-center justify-center text-text-subtle hover:border-primary hover:text-primary transition-colors"
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add Project</TooltipContent>
        </Tooltip>
      </div>

      {/* Footer: report bug + settings */}
      <div className="shrink-0 flex flex-col items-center gap-1 py-2 border-t border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleReportBug}
              className="flex items-center justify-center size-8 rounded-md text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors"
            >
              <Bug className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Report Bug</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleSettings}
              className="flex items-center justify-center size-8 rounded-md text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>

      {/* Add project dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Project</DialogTitle>
          </DialogHeader>
          <AddProjectForm
            onSuccess={() => setAddOpen(false)}
            onCancel={() => setAddOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Project</DialogTitle>
          </DialogHeader>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <DialogFooter>
            <button onClick={() => setRenameOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">
              Cancel
            </button>
            <button onClick={handleRename} className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors">
              Rename
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-text-secondary">
            Remove <strong className="text-foreground">{deleteTarget}</strong> from PPM? The files on disk won't be deleted.
          </p>
          <DialogFooter>
            <button onClick={() => setDeleteOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">
              Cancel
            </button>
            <button onClick={handleDelete} className="px-3 py-1.5 text-sm bg-destructive text-white rounded-md hover:bg-destructive/90 transition-colors">
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Color picker dialog */}
      <Dialog open={colorOpen} onOpenChange={setColorOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Change Color</DialogTitle>
          </DialogHeader>
          <ColorPicker current={colorValue} onChange={setColorValue} />
          <DialogFooter>
            <button onClick={() => setColorOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">
              Cancel
            </button>
            <button onClick={handleColorSave} disabled={colorSaving} className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {colorSaving ? "Saving…" : "Save"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
