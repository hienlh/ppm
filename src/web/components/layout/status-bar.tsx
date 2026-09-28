import { memo, useState } from "react";
import { PanelBottom, GitBranch, ArrowUp, ArrowDown, Check } from "@/lib/icons";
import { useExtensionStore, type StatusBarItemUI } from "@/stores/extension-store";
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { useGitStatusStore } from "@/stores/git-status-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResourceStatusBar } from "@/components/system/resource-status-bar";
import { ProblemsStatus } from "@/components/problems/problems-status";
import { ThemePicker } from "@/components/settings/theme-picker";
import { UpgradeButton } from "@/components/layout/upgrade-button";
import { WakeLockStatusBarItem } from "@/components/layout/wake-lock-indicator";
import { countDockTabs } from "@/components/layout/dock-tabs";
import { BranchPicker } from "@/components/git/branch-picker";
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
    // `@container`: items compact on the bar's own width, which the sidebar decides, not the viewport.
    <div className="@container hidden md:flex items-center justify-between gap-3 h-[26px] px-3.5 bg-panel border-t border-border-soft text-[11px] font-mono text-text-3 select-none shrink-0">
      {/* The side that gives way: the branch name ellipsizes, then the group clips — never paints over the right. */}
      <div className="flex items-center gap-3 min-w-0 overflow-hidden">
        {/* Git: branch · ahead/behind · synced (design status bar). */}
        <GitStatus />
        {/* Errors/warnings across every open file — VS Code's leftmost item. */}
        <ProblemsStatus />
        {left.map((item) => (
          <StatusBarEntry key={item.id} item={item} />
        ))}
        {/* Native panel toggle — the sole dock toggle (sidebar/tab-bar toggles removed). */}
        <DockToggle />
      </div>
      {/* Never shrinks: squeezed, CPU/MEM was its only shrinkable item and wrapped onto two lines. */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Screen-awake marker — only while a wake lock is actually held. */}
        <WakeLockStatusBarItem />
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

/**
 * Git branch + ahead/behind + synced indicator for the active project, and the
 * one way into the branch picker — the same gesture as VS Code's, where this
 * item is the trigger for "Select a branch or tag to checkout".
 *
 * The whole group is the button, counts included, because that is what VS Code
 * makes clickable; the bar is `hidden md:flex`, so the picker it opens is
 * desktop-only by construction rather than by a second breakpoint check.
 */
const GitStatus = memo(function GitStatus() {
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const meta = useGitStatusStore((s) => (activeProjectName ? s.meta.get(activeProjectName) : undefined));
  const [pickerOpen, setPickerOpen] = useState(false);

  if (!meta?.branch || !activeProjectName) return null;
  const { branch, ahead, behind, tracking } = meta;
  const synced = !!tracking && ahead === 0 && behind === 0;

  return (
    <>
      <button
        onClick={() => setPickerOpen(true)}
        title={`Checkout a branch or tag — ${tracking ? `tracking ${tracking}` : "no upstream"}`}
        aria-label={`Current branch ${branch}. Checkout a branch or tag`}
        // `bg-accent/15` is shadcn's hover *surface* at 15% over a near-identical
        // panel — measured at a 1.01 contrast ratio, i.e. no hover at all. The
        // brand blue lives in `primary`; see the note in `branch-picker.tsx`.
        className="flex items-center gap-2 min-w-0 px-1 rounded-sm transition-colors hover:bg-primary/10"
      >
        <span className="flex items-center gap-1 text-primary min-w-0">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate max-w-[140px]">{branch}</span>
        </span>
        {/* On a bar under 36rem the counts give way, so the branch name stays readable. */}
        {(ahead > 0 || behind > 0) && (
          <span className="flex items-center gap-1.5 shrink-0 @max-xl:hidden">
            {ahead > 0 && <span className="flex items-center gap-0.5"><ArrowUp className="size-3" />{ahead}</span>}
            {behind > 0 && <span className="flex items-center gap-0.5"><ArrowDown className="size-3" />{behind}</span>}
          </span>
        )}
        {synced && (
          <span className="flex items-center gap-1 text-success shrink-0 @max-xl:hidden">
            <Check className="size-3" />synced
          </span>
        )}
      </button>
      {pickerOpen && (
        <BranchPicker projectName={activeProjectName} onClose={() => setPickerOpen(false)} />
      )}
    </>
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
