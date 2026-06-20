import { useState, useCallback, useMemo, useRef, useEffect, memo } from "react";
import { createPortal } from "react-dom";
import { Plus, Pencil, Trash2, Palette, Copy, Search, ChevronsUpDown, ExternalLink, Clock, ArrowDownUp, ArrowDownAZ } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore, resolveOrder, sortByRecent, loadRecentTimes, type ProjectInfo, type SortMode } from "@/stores/project-store";
import { buildUrl } from "@/hooks/use-url-sync";
import { formatRelativeDate } from "@/lib/format-date";
import { resolveProjectColor, PROJECT_PALETTE } from "@/lib/project-palette";
import { getProjectInitials } from "@/lib/project-avatar";
import { useNotificationStore, selectProjectUrgentType, notificationColor } from "@/stores/notification-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { AddProjectForm } from "@/components/layout/add-project-form";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Sort modes for the project list (SortMode + persistence live in the store)
// ---------------------------------------------------------------------------
const SORT_OPTIONS: { mode: SortMode; label: string; Icon: typeof Clock }[] = [
  { mode: "recent", label: "Recent", Icon: Clock },
  { mode: "priority", label: "Priority", Icon: ArrowDownUp },
  { mode: "name", label: "Name", Icon: ArrowDownAZ },
];

/** Apply the selected sort to the full project list. */
function applySort(
  projects: ProjectInfo[], customOrder: string[] | null, mode: SortMode,
): ProjectInfo[] {
  if (mode === "recent") return sortByRecent(projects);
  if (mode === "name") return [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return resolveOrder(projects, customOrder); // priority = manual/custom order
}

// ---------------------------------------------------------------------------
// Avatar circle (gradient + initials + urgent notification dot)
// ---------------------------------------------------------------------------
const Avatar = memo(function Avatar({ name, color, size, allNames }: {
  name: string; color: string; size: number; allNames: string[];
}) {
  const initials = getProjectInitials(name, allNames);
  const selector = useMemo(() => selectProjectUrgentType(name), [name]);
  const urgentType = useNotificationStore(selector);
  return (
    <div className="relative shrink-0">
      <div
        className="rounded-full flex items-center justify-center font-bold text-white select-none"
        style={{ background: color, width: size, height: size, fontSize: size <= 24 ? 10 : 11 }}
      >
        {initials}
      </div>
      {urgentType && (
        <div className={cn("absolute -top-0.5 -right-0.5 size-2 rounded-full border-2 border-background", notificationColor(urgentType))} />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Color picker (inline in dialog)
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
// ProjectSwitcher — top-bar button + flyout list + project management
// ---------------------------------------------------------------------------
export const ProjectSwitcher = memo(function ProjectSwitcher() {
  const {
    projects, activeProject, setActiveProject, setProjectColor,
    reorderProjects, renameProject, deleteProject, customOrder,
    sortMode, setProjectSortMode,
  } = useProjectStore(useShallow((s) => ({
    projects: s.projects, activeProject: s.activeProject, setActiveProject: s.setActiveProject,
    setProjectColor: s.setProjectColor, reorderProjects: s.reorderProjects,
    renameProject: s.renameProject, deleteProject: s.deleteProject, customOrder: s.customOrder,
    sortMode: s.projectSortMode, setProjectSortMode: s.setProjectSortMode,
  })));

  const ordered = resolveOrder(projects, customOrder);
  const allNames = ordered.map((p) => p.name);
  const active = activeProject ?? ordered[0] ?? null;
  const activeIdx = active ? ordered.findIndex((p) => p.name === active.name) : -1;
  const activeColor = active ? resolveProjectColor(active.color, activeIdx < 0 ? 0 : activeIdx) : "transparent";

  // Flyout + search. Flyout is portaled to body (the sidebar aside is
  // overflow-hidden, which would otherwise clip a 250px popover).
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const [flyoutPos, setFlyoutPos] = useState<{ left: number; top: number } | null>(null);

  const toggleFlyout = useCallback(() => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setFlyoutPos({ left: rect.left, top: rect.bottom + 4 });
    }
    setOpen((v) => !v);
  }, [open]);

  const closeFlyout = useCallback(() => { setOpen(false); setQuery(""); }, []);

  // Sort (persisted in store) + keyboard navigation
  const [highlightIdx, setHighlightIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Re-sort on open so "recent" picks up fresh localStorage order
  const sortedList = useMemo(
    () => applySort(projects, customOrder, sortMode),
    [projects, customOrder, sortMode, open],
  );
  // Last-opened timestamps (localStorage); refreshed each time the flyout opens
  const recentTimes = useMemo(() => loadRecentTimes(), [open]);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sortedList.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : sortedList;
  const draggable = sortMode === "priority" && !q;

  const openProject = useCallback((p: ProjectInfo) => { setActiveProject(p); closeFlyout(); }, [setActiveProject, closeFlyout]);
  const openInNewTab = useCallback((p: ProjectInfo) => { window.open(buildUrl(p.name, null), "_blank", "noopener"); }, []);

  // Reset highlight when the visible list changes
  useEffect(() => { setHighlightIdx(0); }, [query, sortMode, open]);

  // Keep the highlighted row in view
  useEffect(() => {
    listRef.current?.querySelector(`[data-row-index="${highlightIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[highlightIdx] ?? filtered[0];
      if (!target) return;
      if (e.ctrlKey || e.metaKey) openInNewTab(target);
      else openProject(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFlyout();
    }
  }, [filtered, highlightIdx, openInNewTab, openProject, closeFlyout]);

  // Drag-and-drop reorder
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState("");
  const [colorOpen, setColorOpen] = useState(false);
  const [colorTarget, setColorTarget] = useState("");
  const [colorValue, setColorValue] = useState("");
  const [colorSaving, setColorSaving] = useState(false);

  const openRename = useCallback((name: string) => { setRenameTarget(name); setRenameValue(name); setRenameOpen(true); }, []);
  const openDelete = useCallback((name: string) => { setDeleteTarget(name); setDeleteOpen(true); }, []);
  const openColor = useCallback((name: string, c: string) => { setColorTarget(name); setColorValue(c); setColorOpen(true); }, []);

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
    try { await setProjectColor(colorTarget, colorValue); setColorOpen(false); }
    catch (e) { console.error("Failed to save color:", e); }
    finally { setColorSaving(false); }
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggleFlyout}
        title="Switch project"
        className={cn(
          "flex items-center gap-[9px] w-full h-[31px] px-2 rounded-lg transition-colors border",
          open ? "bg-surface-elevated border-border" : "border-transparent hover:bg-surface-elevated",
        )}
      >
        {active ? (
          <Avatar name={active.name} color={activeColor} size={24} allNames={allNames} />
        ) : (
          <div className="size-6 rounded-full bg-surface-elevated shrink-0" />
        )}
        <div className="min-w-0 flex-1 flex flex-col text-left leading-tight">
          <span className="text-[13px] font-semibold text-foreground truncate">
            {active?.name ?? "Select project"}
          </span>
          {active?.path && (
            <span className="text-[10px] font-mono text-text-subtle truncate">
              {active.path}
            </span>
          )}
        </div>
        <ChevronsUpDown className="size-3.5 text-text-subtle shrink-0" />
      </button>

      {open && flyoutPos && createPortal(
        <>
          {/* backdrop click-catcher */}
          <div className="fixed inset-0 z-40" onClick={closeFlyout} />
          <div
            className="fixed z-50 w-[340px] max-h-[680px] flex flex-col rounded-xl border border-border bg-popover shadow-[0_12px_32px_rgba(0,0,0,.5)] overflow-hidden"
            style={{ left: flyoutPos.left, top: flyoutPos.top }}
          >
            {/* search header */}
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
              <Search className="size-3.5 text-text-subtle shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search projects…"
                autoFocus
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-text-subtle focus:outline-none"
              />
            </div>

            {/* sort selector */}
            <div className="flex items-center gap-1 px-1.5 py-1.5 border-b border-border">
              {SORT_OPTIONS.map(({ mode, label, Icon }) => (
                <button
                  key={mode}
                  onClick={() => setProjectSortMode(mode)}
                  title={`Sort by ${label.toLowerCase()}`}
                  className={cn(
                    "flex items-center justify-center gap-1 flex-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
                    sortMode === mode ? "bg-primary/[0.12] text-primary" : "text-text-subtle hover:bg-surface-elevated hover:text-foreground",
                  )}
                >
                  <Icon className="size-3" /> {label}
                </button>
              ))}
            </div>

            {/* rows */}
            <div ref={listRef} className="overflow-y-auto p-1.5">
              {filtered.map((p, fIdx) => {
                const idx = ordered.findIndex((o) => o.name === p.name);
                const color = resolveProjectColor(p.color, idx);
                const isActive = active?.name === p.name;
                const isHighlighted = fIdx === highlightIdx;
                const isDragging = dragIdx === idx;
                const isDropTarget = dropIdx === idx && dragIdx !== idx;
                const openedAt = recentTimes[p.name];
                return (
                  <ContextMenu key={p.name}>
                    <ContextMenuTrigger asChild>
                      <div
                        data-row-index={fIdx}
                        draggable={draggable}
                        onDragStart={() => draggable && setDragIdx(idx)}
                        onDragOver={(e) => { if (draggable) { e.preventDefault(); setDropIdx(idx); } }}
                        onDragLeave={() => setDropIdx(null)}
                        onDragEnd={() => { setDragIdx(null); setDropIdx(null); }}
                        onDrop={() => {
                          if (draggable && dragIdx != null && dragIdx !== idx) {
                            const names = ordered.map((o) => o.name);
                            const [moved] = names.splice(dragIdx, 1);
                            names.splice(idx, 0, moved!);
                            reorderProjects(names);
                          }
                          setDragIdx(null);
                          setDropIdx(null);
                        }}
                        onMouseEnter={() => setHighlightIdx(fIdx)}
                        className={cn(
                          "group relative flex items-center rounded-lg transition-colors",
                          isActive ? "bg-primary/[0.12]" : isHighlighted ? "bg-surface-elevated" : "",
                          isDragging && "opacity-40",
                          isDropTarget && "ring-2 ring-primary",
                        )}
                      >
                        <button
                          onClick={() => openProject(p)}
                          className="flex items-center gap-2.5 min-w-0 flex-1 px-2 py-1.5 text-left"
                        >
                          <Avatar name={p.name} color={color} size={26} allNames={allNames} />
                          <div className="min-w-0">
                            <div className={cn(
                              "text-[13px] whitespace-nowrap overflow-hidden text-ellipsis",
                              isActive ? "font-semibold text-primary" : "text-foreground",
                            )}>{p.name}</div>
                            <div className="text-[10px] font-mono text-text-subtle whitespace-nowrap overflow-hidden text-ellipsis">{p.path}</div>
                          </div>
                        </button>
                        {openedAt && (
                          <span
                            title={`Last opened ${new Date(openedAt).toLocaleString()}`}
                            className="shrink-0 mr-2 text-[10px] text-text-subtle whitespace-nowrap"
                          >
                            {formatRelativeDate(new Date(openedAt).toISOString())}
                          </span>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); openInNewTab(p); }}
                          title="Open in new browser tab"
                          className={cn(
                            "shrink-0 mr-1 p-1.5 rounded-md text-text-subtle hover:bg-background hover:text-foreground transition-opacity",
                            isHighlighted ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                          )}
                        >
                          <ExternalLink className="size-3.5" />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => openInNewTab(p)}>
                        <ExternalLink className="size-3.5 mr-2" /> Open in New Tab
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => openRename(p.name)}>
                        <Pencil className="size-3.5 mr-2" /> Rename
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => openColor(p.name, color)}>
                        <Palette className="size-3.5 mr-2" /> Change Color
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => navigator.clipboard.writeText(p.path)}>
                        <Copy className="size-3.5 mr-2" /> Copy Path
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem className="text-destructive focus:text-destructive" onClick={() => openDelete(p.name)}>
                        <Trash2 className="size-3.5 mr-2" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-text-subtle">No projects found</div>
              )}
            </div>

            {/* footer: add project */}
            <button
              onClick={() => { setAddOpen(true); closeFlyout(); }}
              className="flex items-center gap-2 px-3 py-2.5 border-t border-border text-text-secondary text-[13px] font-medium hover:bg-surface-elevated transition-colors"
            >
              <Plus className="size-[15px]" /> Add Project
            </button>
          </div>
        </>,
        document.body,
      )}

      {/* Add project dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Add Project</DialogTitle></DialogHeader>
          <AddProjectForm onSuccess={() => setAddOpen(false)} onCancel={() => setAddOpen(false)} />
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename Project</DialogTitle></DialogHeader>
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
            className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <DialogFooter>
            <button onClick={() => setRenameOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleRename} className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors">Rename</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Delete Project</DialogTitle></DialogHeader>
          <p className="text-sm text-text-secondary">
            Remove <strong className="text-foreground">{deleteTarget}</strong> from PPM? The files on disk won't be deleted.
          </p>
          <DialogFooter>
            <button onClick={() => setDeleteOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleDelete} className="px-3 py-1.5 text-sm bg-destructive text-white rounded-md hover:bg-destructive/90 transition-colors">Delete</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Color picker dialog */}
      <Dialog open={colorOpen} onOpenChange={setColorOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Change Color</DialogTitle></DialogHeader>
          <ColorPicker current={colorValue} onChange={setColorValue} />
          <DialogFooter>
            <button onClick={() => setColorOpen(false)} className="px-3 py-1.5 text-sm text-text-secondary hover:text-foreground transition-colors">Cancel</button>
            <button onClick={handleColorSave} disabled={colorSaving} className="px-3 py-1.5 text-sm bg-primary text-white rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50">
              {colorSaving ? "Saving…" : "Save"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
