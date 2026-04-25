import { useState, useCallback, useMemo, useRef, useEffect, memo } from "react";
import { createPortal } from "react-dom";
import { Plus, Settings, Pencil, Trash2, Palette, Bug, Cloud, X, Copy } from "lucide-react";
import { CloudSharePopover } from "./cloud-share-popover";
import { NotificationBellPopover } from "./notification-bell-popover";
import { openBugReportPopup } from "@/lib/report-bug";
import { useShallow } from "zustand/react/shallow";
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
import { useNotificationStore, selectProjectUrgentType, notificationColor } from "@/stores/notification-store";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Avatar circle
// ---------------------------------------------------------------------------
const ProjectAvatar = memo(function ProjectAvatar({ name, color, active, allNames }: {
  name: string; color: string; active: boolean; allNames: string[];
}) {
  const initials = getProjectInitials(name, allNames);
  const selector = useMemo(() => selectProjectUrgentType(name), [name]);
  const urgentType = useNotificationStore(selector);
  return (
    <div className="relative">
      <div
        className={cn(
          "size-10 rounded-full flex items-center justify-center text-xs font-bold text-white select-none shrink-0",
          active && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
        style={{ background: color }}
      >
        {initials}
      </div>
      {urgentType && (
        <div className={cn("absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background", notificationColor(urgentType))} />
      )}
    </div>
  );
});

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
export const ProjectBar = memo(function ProjectBar() {
  const { projects, activeProject, setActiveProject, setProjectColor, reorderProjects, renameProject, deleteProject, customOrder } = useProjectStore(useShallow((s) => ({ projects: s.projects, activeProject: s.activeProject, setActiveProject: s.setActiveProject, setProjectColor: s.setProjectColor, reorderProjects: s.reorderProjects, renameProject: s.renameProject, deleteProject: s.deleteProject, customOrder: s.customOrder })));
  const openTab = useTabStore((s) => s.openTab);
  const version = useSettingsStore((s) => s.version);
  const handleReportBug = useCallback(() => openBugReportPopup(version), [version]);

  // Drag-and-drop reorder
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

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

  // Hover expand (desktop only — ignored on touch devices)
  const [expanded, setExpanded] = useState(false);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseInsideRef = useRef(false);
  const contextMenuOpenRef = useRef(false);
  const canHoverRef = useRef(
    typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches,
  );

  useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  const handleBarMouseEnter = useCallback(() => {
    if (!canHoverRef.current) return;
    mouseInsideRef.current = true;
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
    enterTimerRef.current = setTimeout(() => setExpanded(true), 150);
  }, []);

  const handleBarMouseLeave = useCallback(() => {
    if (!canHoverRef.current) return;
    mouseInsideRef.current = false;
    if (enterTimerRef.current) { clearTimeout(enterTimerRef.current); enterTimerRef.current = null; }
    if (contextMenuOpenRef.current) return;
    leaveTimerRef.current = setTimeout(() => setExpanded(false), 300);
  }, []);

  const handleCtxMenuChange = useCallback((open: boolean) => {
    contextMenuOpenRef.current = open;
    if (!open && !mouseInsideRef.current) {
      leaveTimerRef.current = setTimeout(() => setExpanded(false), 300);
    }
  }, []);

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

  // Cloud + Share popover
  const [cloudOpen, setCloudOpen] = useState(false);
  const cloudBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!cloudOpen || !cloudBtnRef.current) { setPopoverPos(null); return; }
    const rect = cloudBtnRef.current.getBoundingClientRect();
    setPopoverPos({ left: rect.right + 6, bottom: window.innerHeight - rect.bottom });
  }, [cloudOpen]);

  function handleSettings() {
    const { sidebarCollapsed, toggleSidebar, setSidebarActiveTab } = useSettingsStore.getState();
    if (sidebarCollapsed) toggleSidebar();
    setSidebarActiveTab("settings");
  }

  return (
    <div
      className="hidden md:block relative w-[52px] min-w-[52px]"
      onMouseEnter={handleBarMouseEnter}
      onMouseLeave={handleBarMouseLeave}
    >
    <aside className={cn(
      "absolute inset-y-0 left-0 flex flex-col bg-background border-r border-border overflow-hidden transition-[width] duration-200 ease-out",
      expanded ? "w-[240px] shadow-lg z-30" : "w-[52px]",
    )}>
      {/* Logo + version */}
      <div className="shrink-0 flex flex-col items-center justify-center h-[41px] border-b border-border gap-0.5">
        <span className="text-[11px] font-bold text-primary leading-none">PPM</span>
        {version && (
          <span className="text-[8px] text-text-subtle leading-none">v{version}</span>
        )}
      </div>

      {/* Project avatar list */}
      <div className={cn("flex-1 overflow-y-auto py-2 flex flex-col gap-2 min-h-0", expanded ? "items-stretch px-1.5" : "items-center")}>
        {ordered.map((project, idx) => {
          const color = resolveProjectColor(project.color, idx);
          const isActive = activeProject?.name === project.name;
          const isDragging = dragIdx === idx;
          const isDropTarget = dropIdx === idx && dragIdx !== idx;
          return (
            <ContextMenu key={project.name} onOpenChange={handleCtxMenuChange}>
              <ContextMenuTrigger asChild>
                <button
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => { e.preventDefault(); setDropIdx(idx); }}
                  onDragLeave={() => setDropIdx(null)}
                  onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                  onDrop={() => {
                    if (dragIdx != null && dragIdx !== idx) {
                      const names = ordered.map((p) => p.name);
                      const [moved] = names.splice(dragIdx, 1);
                      names.splice(idx, 0, moved!);
                      reorderProjects(names);
                    }
                    setDragIdx(null);
                    setDropIdx(null);
                  }}
                  onClick={() => setActiveProject(project)}
                  className={cn(
                    "p-1 rounded-lg transition-all",
                    !expanded && "hover:bg-surface-elevated",
                    isDragging && "opacity-40 scale-90",
                    isDropTarget && "ring-2 ring-accent",
                    expanded && "w-full flex items-center gap-2 px-2 hover:bg-muted/50",
                  )}
                >
                  <ProjectAvatar name={project.name} color={color} active={isActive} allNames={allNames} />
                  {expanded && (
                    <div className="min-w-0 text-left">
                      <p className="text-sm font-medium truncate">{project.name}</p>
                      <p className="text-[11px] text-text-subtle truncate [direction:rtl] text-left">{project.path}</p>
                    </div>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onClick={() => openRename(project.name)}>
                  <Pencil className="size-3.5 mr-2" /> Rename
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openColor(project.name, color)}>
                  <Palette className="size-3.5 mr-2" /> Change Color
                </ContextMenuItem>
                <ContextMenuItem onClick={() => navigator.clipboard.writeText(project.path)}>
                  <Copy className="size-3.5 mr-2" /> Copy Path
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
        <button
          onClick={handleAddProject}
          className={cn(
            "border-2 border-dashed border-border flex items-center justify-center text-text-subtle hover:border-primary hover:text-primary transition-colors",
            expanded ? "w-full h-10 gap-2 rounded-lg px-2" : "size-10 rounded-full",
          )}
        >
          <Plus className="size-4 shrink-0" />
          {expanded && <span className="text-sm whitespace-nowrap">Add Project</span>}
        </button>
      </div>

      {/* Footer: notifications + cloud + report bug + settings */}
      <div className={cn("shrink-0 flex flex-col gap-1 py-2 border-t border-border", expanded ? "items-stretch px-1.5" : "items-center")}>
        <NotificationBellPopover expanded={expanded} />
        <button
          ref={cloudBtnRef}
          onClick={() => setCloudOpen(!cloudOpen)}
          className={cn(
            "flex items-center rounded-md transition-colors",
            expanded ? "w-full h-8 gap-2 px-2 justify-start" : "justify-center size-8",
            cloudOpen ? "text-primary bg-primary/10" : "text-text-subtle hover:text-foreground hover:bg-surface-elevated",
          )}
        >
          <Cloud className="size-4 shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">Cloud & Share</span>}
        </button>

        {/* Cloud popover — rendered via portal to escape overflow-hidden */}
        {cloudOpen && popoverPos && createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setCloudOpen(false)} />
            <div
              className="fixed z-50"
              style={{ left: popoverPos.left, bottom: popoverPos.bottom }}
            >
              <CloudSharePopover onClose={() => setCloudOpen(false)} />
            </div>
          </>,
          document.body,
        )}

        <button
          onClick={handleReportBug}
          className={cn(
            "flex items-center rounded-md text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors",
            expanded ? "w-full h-8 gap-2 px-2 justify-start" : "justify-center size-8",
          )}
        >
          <Bug className="size-4 shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">Report Bug</span>}
        </button>
        <button
          onClick={handleSettings}
          className={cn(
            "flex items-center rounded-md text-text-subtle hover:text-foreground hover:bg-surface-elevated transition-colors",
            expanded ? "w-full h-8 gap-2 px-2 justify-start" : "justify-center size-8",
          )}
        >
          <Settings className="size-4 shrink-0" />
          {expanded && <span className="text-xs whitespace-nowrap">Settings</span>}
        </button>
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
    </div>
  );
});
