/**
 * DockHeader — desktop dock header (pill strip + position dropdown + maximize/hide).
 * Replaces the full TabBar in the dock. Pills render by tab type via the shared
 * icon map; vertical positions collapse inactive pills + show a `+N` overflow
 * dropdown (see resolveDockPills). Position dropdown persists per-user (settings).
 */
import { PanelLeft, PanelBottom, PanelRight, Maximize2, Minimize2, ChevronDown, Plus, Check, X } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore, type DockPosition } from "@/stores/settings-store";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import { getTabTypeIcon } from "@/lib/tab-type-icons";
import { resolveDockPills } from "./dock-pills";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const POSITION_ICON: Record<DockPosition, React.ElementType> = {
  left: PanelLeft, bottom: PanelBottom, right: PanelRight,
};
const POSITION_LABEL: Record<DockPosition, string> = {
  left: "Left", bottom: "Bottom", right: "Right",
};
const POSITIONS: DockPosition[] = ["left", "bottom", "right"];

export function DockHeader() {
  const dockPanel = usePanelStore((s) => s.panels[DOCK_PANEL_ID]);
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const dockPosition = useSettingsStore((s) => s.dockPosition);
  const setDockPosition = useSettingsStore((s) => s.setDockPosition);
  const dockExpanded = usePanelStore((s) => s.dockExpanded);

  const tabs = (dockPanel?.tabs ?? []).filter(
    (t) => !t.projectId || !activeProjectName || t.projectId === activeProjectName,
  );
  const activeTabId = dockPanel?.activeTabId ?? null;
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const display = resolveDockPills(tabs.map((t) => t.id), activeTabId, dockPosition);

  function activate(tabId: string) {
    usePanelStore.getState().setActiveTab(tabId, DOCK_PANEL_ID);
  }
  function close(tabId: string) {
    usePanelStore.getState().closeTab(tabId, DOCK_PANEL_ID);
  }
  function newPanelTab() {
    const project = useProjectStore.getState().activeProject;
    usePanelStore.getState().openInDock({
      type: "terminal", title: "Terminal", projectId: project?.name ?? null,
      closable: true, metadata: project ? { projectName: project.name } : undefined,
    });
  }

  const PositionIcon = POSITION_ICON[dockPosition];

  return (
    <div className="flex items-center h-8 min-w-0 flex-1 gap-1 px-1">
      {/* Pill strip */}
      <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
        {display.visible.map((id) => {
          const tab = byId.get(id);
          if (!tab) return null;
          const Icon = getTabTypeIcon(tab.type);
          const isActive = id === activeTabId;
          const showLabel = !display.iconOnlyInactive || isActive;
          const pill = (
            <button
              key={id}
              onClick={() => activate(id)}
              className={cn(
                "flex items-center gap-1.5 h-6 rounded-full border shrink-0 transition-colors",
                showLabel ? "px-2.5" : "px-1.5",
                isActive
                  ? "border-primary text-primary bg-primary/10"
                  : "border-border text-text-secondary hover:bg-surface-elevated",
              )}
            >
              <Icon className="size-3" />
              {showLabel && <span className="text-[11px] font-medium max-w-[120px] truncate">{tab.title}</span>}
              {showLabel && tab.closable && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.title}`}
                  onClick={(e) => { e.stopPropagation(); close(id); }}
                  className="flex items-center justify-center size-4 -mr-1 rounded hover:bg-surface-elevated hover:text-foreground"
                >
                  <X className="size-3" />
                </span>
              )}
            </button>
          );
          // Icon-only inactive pills expose their title via tooltip.
          return showLabel ? pill : (
            <Tooltip key={id}>
              <TooltipTrigger asChild>{pill}</TooltipTrigger>
              <TooltipContent side="top" className="text-xs">{tab.title}</TooltipContent>
            </Tooltip>
          );
        })}

        {/* Overflow chip (+N) — vertical positions only */}
        {display.overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center justify-center h-6 px-2 rounded-full border border-border text-text-secondary text-[10px] font-mono shrink-0 hover:bg-surface-elevated">
                +{display.overflow.length}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[10rem]">
              {display.overflow.map((id) => {
                const tab = byId.get(id);
                if (!tab) return null;
                const Icon = getTabTypeIcon(tab.type);
                return (
                  <DropdownMenuItem key={id} onClick={() => activate(id)}>
                    <Icon className="size-3.5" />
                    <span className="truncate">{tab.title}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* New panel tab */}
        <button
          onClick={newPanelTab}
          title="New panel tab"
          aria-label="New panel tab"
          className="flex items-center justify-center size-6 rounded-full border border-dashed border-border text-text-subtle shrink-0 hover:bg-surface-elevated hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {/* Position dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            title="Panel position"
            aria-label="Panel position"
            className="flex items-center gap-0.5 h-6 px-1.5 rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground shrink-0"
          >
            <PositionIcon className="size-3.5" />
            <ChevronDown className="size-2.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-text-subtle">Panel Position</DropdownMenuLabel>
          {POSITIONS.map((pos) => {
            const Icon = POSITION_ICON[pos];
            const active = pos === dockPosition;
            return (
              <DropdownMenuItem
                key={pos}
                onClick={() => setDockPosition(pos)}
                className={cn(active && "text-primary bg-primary/10")}
              >
                <Icon className="size-3.5" />
                <span className="flex-1">{POSITION_LABEL[pos]}</span>
                {active && <Check className="size-3.5" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Divider */}
      <div className="w-px h-4 bg-border shrink-0" />

      {/* Maximize / restore */}
      <button
        onClick={() => usePanelStore.getState().toggleDockExpanded()}
        title={dockExpanded ? "Restore panel" : "Maximize panel"}
        aria-label={dockExpanded ? "Restore panel" : "Maximize panel"}
        className="flex items-center justify-center size-7 rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground shrink-0"
      >
        {dockExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>

      {/* Hide */}
      <button
        onClick={() => usePanelStore.getState().setDockVisible(false)}
        title="Hide panel"
        aria-label="Hide panel"
        className="flex items-center justify-center size-7 rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground shrink-0"
      >
        <ChevronDown className="size-3.5" />
      </button>
    </div>
  );
}
