import { memo } from "react";
import { PanelBottom, GitBranch, ArrowUp, ArrowDown, Check } from "lucide-react";
import { useExtensionStore, type StatusBarItemUI } from "@/stores/extension-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useGitStatusStore } from "@/stores/git-status-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResourceStatusBar } from "@/components/system/resource-status-bar";
import { ThemePicker } from "@/components/settings/theme-picker";
import { UpgradeButton } from "@/components/layout/upgrade-button";
import { countDockTabs } from "@/components/layout/dock-tabs";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";
import { cn } from "@/lib/utils";

/** Fixed status bar at the bottom of the editor area (hidden on mobile) */
export const StatusBar = memo(function StatusBar() {
  const items = useExtensionStore((s) => s.statusBarItems);

  const left = items
    .filter((i) => i.alignment === "left")
    .sort((a, b) => b.priority - a.priority);

  const right = items
    .filter((i) => i.alignment === "right")
    .sort((a, b) => b.priority - a.priority);

  return (
    <div className="hidden md:flex items-center justify-between h-[26px] px-3.5 bg-panel border-t border-border-soft text-[11px] font-mono text-text-3 select-none shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        {/* Git: branch · ahead/behind · synced (design status bar). */}
        <GitStatus />
        {left.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
        {/* Native panel toggle — the sole dock toggle (sidebar/tab-bar toggles removed). */}
        <DockToggle />
      </div>
      <div className="flex items-center gap-3 min-w-0">
        {/* CPU/MEM moved here from the sidebar resource strip. */}
        <ResourceStatusBar compact />
        {right.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
        {/* Theme picker — palette button opens the theme dropdown. */}
        <ThemePicker />
        {/* Version + update button (replaces the old top upgrade banner). */}
        <UpgradeButton />
      </div>
    </div>
  );
});

/** Git branch + ahead/behind + synced indicator for the active project. */
const GitStatus = memo(function GitStatus() {
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const meta = useGitStatusStore((s) => (activeProjectName ? s.meta.get(activeProjectName) : undefined));

  if (!meta?.branch) return null;
  const { branch, ahead, behind, tracking } = meta;
  const synced = !!tracking && ahead === 0 && behind === 0;

  return (
    <span className="flex items-center gap-2 min-w-0 shrink-0">
      <span className="flex items-center gap-1 text-primary min-w-0" title={tracking ? `Tracking ${tracking}` : "No upstream"}>
        <GitBranch className="size-3 shrink-0" />
        <span className="truncate max-w-[140px]">{branch}</span>
      </span>
      {(ahead > 0 || behind > 0) && (
        <span className="flex items-center gap-1.5 shrink-0">
          {ahead > 0 && <span className="flex items-center gap-0.5"><ArrowUp className="size-3" />{ahead}</span>}
          {behind > 0 && <span className="flex items-center gap-0.5"><ArrowDown className="size-3" />{behind}</span>}
        </span>
      )}
      {synced && (
        <span className="flex items-center gap-1 text-success shrink-0">
          <Check className="size-3" />synced
        </span>
      )}
    </span>
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
