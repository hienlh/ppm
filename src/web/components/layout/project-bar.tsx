import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Plus, Settings, Pencil, Trash2, Palette, Bug, Share2, Loader2, Copy, Check, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { openBugReportPopup } from "@/lib/report-bug";
import { api } from "@/lib/api-client";
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
  const { projects, activeProject, setActiveProject, setProjectColor, reorderProjects, renameProject, deleteProject, customOrder } = useProjectStore();
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

  // Share tunnel
  const [shareOpen, setShareOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareChecking, setShareChecking] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; bottom: number } | null>(null);

  // Position popover relative to button
  useEffect(() => {
    if (!shareOpen || !shareBtnRef.current) { setPopoverPos(null); return; }
    const rect = shareBtnRef.current.getBoundingClientRect();
    setPopoverPos({ left: rect.right + 6, bottom: window.innerHeight - rect.bottom });
  }, [shareOpen]);

  const handleShare = useCallback(async () => {
    if (shareOpen) { setShareOpen(false); return; }
    setShareOpen(true);
    setShareError(null);
    setShareUrl(null);
    setShareChecking(true);

    // Only check existing tunnel, don't auto-start
    try {
      const status = await api.get<{ active: boolean; url: string | null }>("/api/tunnel");
      if (status.active && status.url) {
        setShareUrl(status.url);
      }
    } catch { /* no existing tunnel */ }
    setShareChecking(false);
  }, [shareOpen]);

  const handleStartTunnel = useCallback(async () => {
    setShareLoading(true);
    setShareError(null);
    try {
      const result = await api.post<{ url: string }>("/api/tunnel/start", {});
      setShareUrl(result.url);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : "Failed to start tunnel");
    } finally {
      setShareLoading(false);
    }
  }, []);

  const handleCopyUrl = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [shareUrl]);

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
          const isDragging = dragIdx === idx;
          const isDropTarget = dropIdx === idx && dragIdx !== idx;
          return (
            <ContextMenu key={project.name}>
              <Tooltip>
                <TooltipTrigger asChild>
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
                      className={`p-1 rounded-lg hover:bg-surface-elevated transition-all ${
                        isDragging ? "opacity-40 scale-90" : ""
                      } ${isDropTarget ? "ring-2 ring-accent" : ""}`}
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

      {/* Footer: share + report bug + settings */}
      <div className="shrink-0 flex flex-col items-center gap-1 py-2 border-t border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={shareBtnRef}
              onClick={handleShare}
              className={cn(
                "flex items-center justify-center size-8 rounded-md transition-colors",
                shareOpen ? "text-primary bg-primary/10" : "text-text-subtle hover:text-foreground hover:bg-surface-elevated",
              )}
            >
              <Share2 className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Share</TooltipContent>
        </Tooltip>

        {/* Share popover — rendered via portal to escape overflow-hidden */}
        {shareOpen && popoverPos && createPortal(
          <>
            {/* Backdrop to close popover */}
            <div className="fixed inset-0 z-40" onClick={() => setShareOpen(false)} />
            <div
              className="fixed z-50 w-64 bg-background border border-border rounded-lg shadow-lg p-3 space-y-3"
              style={{ left: popoverPos.left, bottom: popoverPos.bottom }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Share</span>
                <button onClick={() => setShareOpen(false)} className="text-text-subtle hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              </div>

              {/* Checking existing tunnel */}
              {shareChecking && (
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <Loader2 className="size-4 animate-spin" />
                  <span>Checking...</span>
                </div>
              )}

              {/* No tunnel yet — show start button */}
              {!shareChecking && !shareUrl && !shareLoading && !shareError && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Create a public link so others can access this PPM instance from anywhere.
                  </p>
                  <button
                    onClick={handleStartTunnel}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Share2 className="size-3.5" />
                    Start Sharing
                  </button>
                </div>
              )}

              {/* Starting tunnel */}
              {shareLoading && (
                <div className="flex flex-col items-center gap-2 py-2">
                  <Loader2 className="size-5 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">Starting tunnel... this may take a moment</span>
                </div>
              )}

              {/* Error */}
              {shareError && (
                <div className="space-y-2">
                  <p className="text-xs text-destructive">{shareError}</p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleStartTunnel}
                      className="flex-1 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => { setShareOpen(false); handleReportBug(); }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border border-border text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Bug className="size-3" />
                      Report
                    </button>
                  </div>
                </div>
              )}

              {/* Tunnel active — show QR + URL */}
              {shareUrl && (
                <>
                  <div className="flex justify-center">
                    <QRCodeSVG value={shareUrl} size={160} />
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      readOnly
                      value={shareUrl}
                      className="flex-1 text-xs font-mono text-foreground bg-muted px-2 py-1.5 rounded border border-border truncate"
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                    />
                    <button
                      onClick={handleCopyUrl}
                      className="flex items-center justify-center size-7 rounded border border-border text-muted-foreground bg-muted hover:bg-accent hover:text-foreground transition-colors shrink-0"
                      title="Copy URL"
                    >
                      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>,
          document.body,
        )}

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
