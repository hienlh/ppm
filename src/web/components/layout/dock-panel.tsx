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
import { X, Terminal, Plus } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import { useProjectStore } from "@/stores/project-store";
import { registerPanelSlot } from "./tab-pool";
import { TabBar } from "./tab-bar";
import { cn } from "@/lib/utils";
import type { TabType } from "@/stores/tab-store";

const TAB_ICONS: Partial<Record<TabType, React.ElementType>> = {
  terminal: Terminal,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DockPanelProps {
  /** "mobile" renders a compact touch-friendly header; "desktop" (default) uses full TabBar. */
  variant?: "mobile" | "desktop";
}

// ---------------------------------------------------------------------------
// DockPanel
// ---------------------------------------------------------------------------

export function DockPanel({ variant = "desktop" }: DockPanelProps) {
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
    <div className="flex flex-col h-full overflow-hidden border-t border-border bg-background">
      {/* Header row */}
      <div className="flex items-center shrink-0">
        {variant === "mobile" ? (
          <MobileDockHeader />
        ) : (
          /* Desktop: full TabBar (hidden md:flex — always visible on desktop) */
          <div className="flex-1 min-w-0">
            <TabBar panelId={DOCK_PANEL_ID} />
          </div>
        )}

        {/* Close dock — hides without killing tabs */}
        <button
          onClick={() => usePanelStore.getState().setDockVisible(false)}
          title="Hide terminal dock"
          className={cn(
            "shrink-0 flex items-center justify-center mr-1",
            // 44px touch target on mobile, 32px on desktop
            variant === "mobile" ? "size-11" : "size-8",
            "text-text-subtle hover:text-foreground hover:bg-surface-elevated",
            "active:bg-surface-elevated rounded transition-colors",
          )}
          aria-label="Hide terminal dock"
        >
          <X className="size-3.5" />
        </button>
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
    <div className="flex-1 min-w-0 flex items-center h-11 overflow-hidden">
      {/* Scrollable tab list */}
      <div className="flex-1 min-w-0 flex items-center h-11 overflow-x-auto scrollbar-none">
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.type] ?? Terminal;
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabPress(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 h-11 whitespace-nowrap text-xs shrink-0 border-b-2 transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-text-secondary",
              )}
            >
              <Icon className="size-3.5" />
              <span className="max-w-[64px] truncate">{tab.title}</span>
            </button>
          );
        })}
      </div>

      {/* New terminal — 44px touch target, always visible */}
      <button
        onClick={handleNewTerminal}
        title="New terminal"
        className={cn(
          "shrink-0 flex items-center justify-center size-11",
          "text-text-subtle hover:text-foreground active:bg-surface-elevated",
          "transition-colors",
        )}
        aria-label="New terminal"
      >
        <Plus className="size-4" />
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
