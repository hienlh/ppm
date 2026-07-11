/**
 * DockPanel — the bottom terminal dock shared by desktop and mobile.
 * Desktop: rendered inside the resizable Group (panel-layout.tsx).
 * Mobile: rendered inside a BottomSheet (mobile-nav.tsx) via variant="mobile".
 *
 * Keep-alive: registerPanelSlot(__dock__, el) lets TabPool reparent live
 * xterm nodes without remounting — no PTY restart on hide/show.
 * Close calls setDockVisible(false); real kill = close-from-dock / shell exit / idle-grace.
 */
import { useCallback } from "react";
import { X, Terminal, Plus, Maximize2, Minimize2 } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import { useProjectStore } from "@/stores/project-store";
import { registerPanelSlot } from "./tab-pool";
import { DockHeader } from "./dock-header";
import { getTabTypeIcon } from "@/lib/tab-type-icons";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DockPanelProps {
  /** "mobile" renders a compact touch-friendly header; "desktop" (default) uses full TabBar. */
  variant?: "mobile" | "desktop";
  /** Which edge carries the content-facing hairline border (desktop position-aware). */
  borderEdge?: "top" | "left" | "right";
}

const BORDER_EDGE_CLASS: Record<NonNullable<DockPanelProps["borderEdge"]>, string> = {
  top: "border-t",
  left: "border-l",
  right: "border-r",
};

// ---------------------------------------------------------------------------
// DockPanel
// ---------------------------------------------------------------------------

export function DockPanel({ variant = "desktop", borderEdge = "top" }: DockPanelProps) {
  const dockPanel = usePanelStore((s) => s.panels[DOCK_PANEL_ID]);
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  // The shared __dock__ panel holds tabs from all projects; only the active
  // project's tabs are visible here (empty-state must reflect the active project).
  const hasTabs = (dockPanel?.tabs ?? []).some(
    (t) => !t.projectId || !activeProjectName || t.projectId === activeProjectName,
  );

  // Callback ref fires synchronously on mount/unmount — mirrors EditorPanel pattern.
  const slotCallbackRef = useCallback((el: HTMLDivElement | null) => {
    registerPanelSlot(DOCK_PANEL_ID, el);
  }, []);

  return (
    <div className={cn("flex flex-col h-full overflow-hidden border-border bg-panel", BORDER_EDGE_CLASS[borderEdge])}>
      {/* Header row */}
      <div className="flex items-center shrink-0">
        {variant === "mobile" ? (
          <>
            <MobileDockHeader />
            {/* Mobile hide — 44px touch target. Desktop hide lives inside DockHeader. */}
            <button
              onClick={() => usePanelStore.getState().setDockVisible(false)}
              title="Hide terminal dock"
              className={cn(
                "shrink-0 flex items-center justify-center mr-1 size-11",
                "text-text-subtle hover:text-foreground hover:bg-surface-elevated",
                "active:bg-surface-elevated rounded transition-colors",
              )}
              aria-label="Hide terminal dock"
            >
              <X className="size-3.5" />
            </button>
          </>
        ) : (
          /* Desktop: pill strip + position dropdown + maximize/hide */
          <DockHeader />
        )}
      </div>

      {/* Content: slot for reparenting + optional empty state */}
      <div className="flex-1 overflow-hidden relative">
        {!hasTabs && <DockEmptyState variant={variant} />}
        {/* Slot always rendered so TabPool can reparent immediately; hidden when empty. */}
        <div
          ref={slotCallbackRef}
          className="absolute inset-0"
          style={hasTabs ? undefined : { display: "none" }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileDockHeader — compact tab strip for <768px.
// TabBar uses "hidden md:flex" so it's invisible on mobile; this replaces it.
// ---------------------------------------------------------------------------

function MobileDockHeader() {
  const dockPanel = usePanelStore((s) => s.panels[DOCK_PANEL_ID]);
  const activeProject = useProjectStore((s) => s.activeProject);
  const dockExpanded = usePanelStore((s) => s.dockExpanded);
  // Only show the active project's dock tabs (shared __dock__ holds all projects').
  const projectName = activeProject?.name ?? null;
  const tabs = (dockPanel?.tabs ?? []).filter(
    (t) => !t.projectId || !projectName || t.projectId === projectName,
  );
  const activeTabId = dockPanel?.activeTabId ?? null;

  function handleTabPress(tabId: string) {
    usePanelStore.getState().setActiveTab(tabId, DOCK_PANEL_ID);
  }

  function handleNewTerminal() {
    const project = activeProject;
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal",
      projectId: project?.name ?? null,
      closable: true,
      metadata: project ? { projectName: project.name } : undefined,
    });
  }

  return (
    <div className="flex-1 min-w-0 flex items-center h-11 gap-1 pl-2 overflow-hidden">
      {/* Scrollable session pill strip */}
      <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => {
          const Icon = getTabTypeIcon(tab.type);
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabPress(tab.id)}
              className={cn(
                "flex items-center gap-1.5 h-8 px-3 rounded-full border shrink-0 transition-colors",
                isActive
                  ? "border-primary text-primary bg-primary/10"
                  : "border-border text-text-secondary",
              )}
            >
              <Icon className="size-[13px]" />
              <span className="max-w-[96px] truncate text-xs font-medium">{tab.title}</span>
            </button>
          );
        })}
        {/* New panel tab — dashed circle */}
        <button
          onClick={handleNewTerminal}
          title="New panel tab"
          aria-label="New panel tab"
          className="shrink-0 flex items-center justify-center size-8 rounded-full border border-dashed border-border text-text-subtle active:bg-surface-elevated"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* Expand / collapse (60% ↔ 92%) */}
      <button
        onClick={() => usePanelStore.getState().toggleDockExpanded()}
        title={dockExpanded ? "Collapse panel" : "Expand panel"}
        aria-label={dockExpanded ? "Collapse panel" : "Expand panel"}
        className="shrink-0 flex items-center justify-center size-9 text-text-subtle active:bg-surface-elevated rounded transition-colors"
      >
        {dockExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DockEmptyState — minimal affordance (not the full EmptyPanel quick-open)
// ---------------------------------------------------------------------------

function DockEmptyState({ variant }: { variant?: "mobile" | "desktop" }) {
  const activeProject = useProjectStore((s) => s.activeProject);

  function handleOpenTerminal() {
    const project = activeProject;
    usePanelStore.getState().openInDock({
      type: "terminal",
      title: "Terminal",
      projectId: project?.name ?? null,
      closable: true,
      metadata: project ? { projectName: project.name } : undefined,
    });
  }

  return (
    <div className="flex items-center justify-center h-full">
      <button
        onClick={handleOpenTerminal}
        className={cn(
          "flex items-center gap-2 rounded-md",
          // Larger touch target on mobile
          variant === "mobile" ? "px-4 py-3" : "px-3 py-2",
          "border border-border bg-surface hover:bg-surface-elevated active:bg-surface-elevated",
          "text-sm text-foreground transition-colors",
        )}
      >
        <Terminal className="size-4" />
        Open Terminal
      </button>
    </div>
  );
}
