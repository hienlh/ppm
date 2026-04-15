import { useState, useRef, useCallback } from "react";
import { X, Check, Plus, Settings, ChevronUp, ChevronDown, Pencil, Trash2, Palette, ArrowLeft } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useSettingsStore } from "@/stores/settings-store";
import { AddProjectForm } from "@/components/layout/add-project-form";
import { resolveProjectColor, PROJECT_PALETTE } from "@/lib/project-palette";
import { getProjectInitials } from "@/lib/project-avatar";
import { cn } from "@/lib/utils";

interface ProjectBottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

// Action sheet for long-press context menu
interface ActionSheetItem {
  label: string;
  icon: React.ElementType;
  onClick: () => void;
  destructive?: boolean;
}

function ProjectAvatar({ name, color, allNames }: { name: string; color: string; allNames: string[] }) {
  const initials = getProjectInitials(name, allNames);
  return (
    <div
      className="size-10 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
      style={{ background: color }}
    >
      {initials}
    </div>
  );
}

export function ProjectBottomSheet({ isOpen, onClose }: ProjectBottomSheetProps) {
  const { projects, activeProject, setActiveProject, setProjectColor, reorderProjects, renameProject, deleteProject, customOrder } = useProjectStore(useShallow((s) => ({ projects: s.projects, activeProject: s.activeProject, setActiveProject: s.setActiveProject, setProjectColor: s.setProjectColor, reorderProjects: s.reorderProjects, renameProject: s.renameProject, deleteProject: s.deleteProject, customOrder: s.customOrder })));

  const openTab = useTabStore((s) => s.openTab);
  const version = useSettingsStore((s) => s.version);

  const ordered = resolveOrder(projects, customOrder);
  const allNames = ordered.map((p) => p.name);

  // View: "list" | "add"
  const [view, setView] = useState<"list" | "add">("list");

  // Long-press state for action sheet
  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const [actionColor, setActionColor] = useState("");
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Rename inline state
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const startLongPress = useCallback((name: string) => {
    longPressTimer.current = setTimeout(() => setActionTarget(name), 400);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  function handleClose() {
    setView("list");
    onClose();
  }

  function handleSelectProject(name: string) {
    const project = projects.find((p) => p.name === name);
    if (project) { setActiveProject(project); handleClose(); }
  }

  function handleAddProject() {
    setView("add");
  }

  function handleSettings() {
    handleClose();
    // Mobile: open drawer with settings tab
    if (window.innerWidth < 768) {
      window.dispatchEvent(new Event("open-mobile-settings"));
      return;
    }
    // Desktop: open sidebar settings tab
    const { sidebarCollapsed, toggleSidebar, setSidebarActiveTab } = useSettingsStore.getState();
    if (sidebarCollapsed) toggleSidebar();
    setSidebarActiveTab("settings");
  }

  async function handleRename() {
    if (!renameTarget || !renameValue.trim() || renameValue === renameTarget) {
      setRenameTarget(null);
      return;
    }
    try { await renameProject(renameTarget, renameValue.trim()); } catch { /* ignore */ }
    setRenameTarget(null);
  }

  async function handleDelete(name: string) {
    setActionTarget(null);
    try { await deleteProject(name); } catch { /* ignore */ }
  }

  async function handleColorSave(name: string, color: string) {
    try {
      await setProjectColor(name, color);
      setColorPickerOpen(false);
      setActionTarget(null);
    } catch (e) {
      console.error("Failed to save color:", e);
    }
  }

  const actionProject = actionTarget ? ordered.find((p) => p.name === actionTarget) : null;
  const actionIdx = actionTarget ? ordered.findIndex((p) => p.name === actionTarget) : -1;

  const actionItems: ActionSheetItem[] = actionTarget ? [
    {
      label: "Rename",
      icon: Pencil,
      onClick: () => {
        setRenameValue(actionTarget);
        setRenameTarget(actionTarget);
        setActionTarget(null);
      },
    },
    {
      label: "Change Color",
      icon: Palette,
      onClick: () => {
        const idx = ordered.findIndex((p) => p.name === actionTarget);
        const project = ordered[idx];
        setActionColor(resolveProjectColor(project?.color, idx));
        setColorPickerOpen(true);
      },
    },
    ...(actionIdx > 0 ? [{
      label: "Move Up",
      icon: ChevronUp,
      onClick: () => {
        const names = ordered.map((p) => p.name);
        const [moved] = names.splice(actionIdx, 1);
        names.splice(actionIdx - 1, 0, moved!);
        reorderProjects(names);
        setActionTarget(null);
      },
    }] : []),
    ...(actionIdx < ordered.length - 1 ? [{
      label: "Move Down",
      icon: ChevronDown,
      onClick: () => {
        const names = ordered.map((p) => p.name);
        const [moved] = names.splice(actionIdx, 1);
        names.splice(actionIdx + 1, 0, moved!);
        reorderProjects(names);
        setActionTarget(null);
      },
    }] : []),
    {
      label: "Delete",
      icon: Trash2,
      destructive: true,
      onClick: () => handleDelete(actionTarget),
    },
  ] : [];

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onClick={handleClose}
        style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      />

      {/* Sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-50 md:hidden bg-background rounded-t-2xl border-t border-border shadow-2xl",
          "transition-transform duration-300 ease-out",
          isOpen ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            {view === "add" && (
              <button
                onClick={() => setView("list")}
                className="flex items-center justify-center size-7 rounded-md hover:bg-surface-elevated transition-colors"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            <span className="text-sm font-semibold">{view === "add" ? "Add Project" : "Projects"}</span>
          </div>
          <button
            onClick={handleClose}
            className="flex items-center justify-center size-7 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Add project form */}
        {view === "add" && (
          <div className="px-4 py-4">
            <AddProjectForm
              onSuccess={() => { setView("list"); onClose(); }}
              onCancel={() => setView("list")}
              footerClassName="pt-2"
            />
          </div>
        )}

        {/* Project list */}
        <div className={view === "add" ? "hidden" : "max-h-[60vh] overflow-y-auto"}>
          {ordered.map((project, idx) => {
            const color = resolveProjectColor(project.color, idx);
            const isActive = activeProject?.name === project.name;
            const isRenaming = renameTarget === project.name;

            return (
              <div
                key={project.name}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 transition-colors active:bg-surface-elevated",
                  isActive && "bg-accent/10",
                )}
                onClick={() => !isRenaming && handleSelectProject(project.name)}
                onTouchStart={() => startLongPress(project.name)}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
              >
                <ProjectAvatar name={project.name} color={color} allNames={allNames} />

                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRename();
                        if (e.key === "Escape") setRenameTarget(null);
                      }}
                      onBlur={handleRename}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full bg-transparent border-b border-primary text-sm outline-none"
                      autoFocus
                    />
                  ) : (
                    <p className="text-sm font-medium truncate">{project.name}</p>
                  )}
                  <p className="text-xs text-text-subtle truncate">{project.path}</p>
                </div>

                {isActive && <Check className="size-4 text-primary shrink-0" />}
              </div>
            );
          })}
        </div>

        {/* Footer actions */}
        <div className="border-t border-border">
          <button
            onClick={handleAddProject}
            className="w-full flex items-center gap-3 px-4 py-3 text-text-secondary hover:bg-surface-elevated transition-colors"
          >
            <Plus className="size-4 shrink-0" />
            <span className="text-sm">Add Project</span>
          </button>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button
            onClick={handleSettings}
            className="flex items-center gap-2 text-text-secondary hover:text-foreground transition-colors"
          >
            <Settings className="size-4" />
            <span className="text-sm">Settings</span>
          </button>
          {version && <span className="text-xs text-text-subtle">v{version}</span>}
        </div>
      </div>

      {/* Long-press action sheet */}
      {actionTarget && !colorPickerOpen && (
        <>
          <div className="fixed inset-0 z-[60] md:hidden" onClick={() => setActionTarget(null)} />
          <div className="fixed bottom-0 left-0 right-0 z-[61] md:hidden bg-surface border-t border-border rounded-t-2xl shadow-2xl animate-in slide-in-from-bottom-2 duration-150">
            <div className="px-4 py-2 border-b border-border">
              <p className="text-xs font-medium text-text-secondary">{actionTarget}</p>
            </div>
            {actionItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={item.onClick}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors active:bg-surface-elevated",
                    item.destructive ? "text-destructive" : "text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* Color picker sheet */}
      {colorPickerOpen && actionTarget && (
        <>
          <div className="fixed inset-0 z-[60] md:hidden" onClick={() => { setColorPickerOpen(false); setActionTarget(null); }} />
          <div className="fixed bottom-0 left-0 right-0 z-[61] md:hidden bg-surface border-t border-border rounded-t-2xl shadow-2xl p-4 space-y-4">
            <p className="text-sm font-medium">Change Color</p>
            <div className="flex flex-wrap gap-3">
              {PROJECT_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setActionColor(c)}
                  className={cn(
                    "size-9 rounded-full border-2 transition-all",
                    actionColor === c ? "border-primary scale-110" : "border-transparent",
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => { setColorPickerOpen(false); setActionTarget(null); }}
                className="flex-1 py-2 text-sm text-text-secondary border border-border rounded-md"
              >Cancel</button>
              <button
                onClick={() => handleColorSave(actionTarget, actionColor)}
                className="flex-1 py-2 text-sm bg-primary text-white rounded-md"
              >Save</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
