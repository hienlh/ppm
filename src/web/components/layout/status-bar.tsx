import { memo } from "react";
import { PanelBottom } from "lucide-react";
import { useExtensionStore, type StatusBarItemUI } from "@/stores/extension-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResourceStatusBar } from "@/components/system/resource-status-bar";
import { countDockTabs } from "@/components/layout/dock-tabs";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import { cn } from "@/lib/utils";

/** Fixed status bar at the bottom of the editor area (hidden on mobile) */
export const StatusBar = memo(function StatusBar() {
  const items = useExtensionStore((s) => s.statusBarItems);
  const version = useSettingsStore((s) => s.version);

  const left = items
    .filter((i) => i.alignment === "left")
    .sort((a, b) => b.priority - a.priority);

  const right = items
    .filter((i) => i.alignment === "right")
    .sort((a, b) => b.priority - a.priority);

  return (
    <div className="hidden md:flex items-center justify-between h-[22px] px-2 bg-surface border-t border-border text-[11px] text-text-subtle select-none shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {left.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
        {/* Native panel toggle — the sole dock toggle (sidebar/tab-bar toggles removed). */}
        <DockToggle />
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {/* CPU/MEM moved here from the sidebar resource strip. */}
        <ResourceStatusBar compact />
        {right.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
        {/* Version — moved here from the sidebar wordmark (handoff B2). */}
        {version && <span className="px-1 shrink-0">v{version}</span>}
      </div>
    </div>
  );
});

/** The only panel-dock toggle: PanelBottom + open-tab count, primary tint when open. */
const DockToggle = memo(function DockToggle() {
  const dockVisible = usePanelStore((s) => s.dock.visible);
  const dockPanel = usePanelStore((s) => s.panels[DOCK_PANEL_ID]);
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const count = countDockTabs(dockPanel, activeProjectName);

  return (
    <button
      onClick={() => usePanelStore.getState().toggleDock()}
      title={dockVisible ? "Hide panel" : "Show panel"}
      aria-label={dockVisible ? "Hide panel" : "Show panel"}
      className={cn(
        "flex items-center gap-1 px-1 rounded-sm transition-colors hover:bg-accent/15",
        dockVisible ? "text-primary" : "text-text-subtle hover:text-text-primary",
      )}
    >
      <PanelBottom className="size-[11px]" />
      {count > 0 && <span>{count}</span>}
    </button>
  );
});

const StatusBarEntry = memo(function StatusBarEntry({ item }: { item: StatusBarItemUI }) {
  const content = (
    <button
      className={`truncate px-1 rounded-sm transition-colors ${
        item.command
          ? "hover:bg-accent/15 hover:text-text-primary cursor-pointer"
          : "cursor-default"
      }`}
      onClick={() => {
        if (item.command) {
          window.dispatchEvent(new CustomEvent("ext:command:execute", {
            detail: { command: item.command },
          }));
        }
      }}
    >
      {item.text}
    </button>
  );

  if (item.tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {item.tooltip}
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
});
