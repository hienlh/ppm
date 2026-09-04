/**
 * Shared shell for the System Monitor: connection indicator, warning strip, and the
 * Overview/Processes sub-tabs. Rendered identically by the desktop window and the
 * mobile tab, so this file and the panels beneath it are written once for both hosts.
 */
import { lazy, memo, Suspense, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResourceMonitor } from "@/hooks/use-resource-monitor";

const OverviewPanel = lazy(() =>
  import("./overview-panel").then((m) => ({ default: m.OverviewPanel })),
);
const ProcessTable = lazy(() =>
  import("./process-table").then((m) => ({ default: m.ProcessTable })),
);

type SysMonTab = "overview" | "processes";

export interface SystemMonitorBodyProps {
  initialTab?: SysMonTab;
  onTabChange?: (tab: SysMonTab) => void;
  /** "window" (desktop floating window) suppresses the inner "System Monitor" title —
   *  the window's own titlebar already shows it — and moves the connection indicator
   *  into the tab strip instead. "tab" (default; the mobile route, which has no
   *  titlebar) keeps the full header. */
  variant?: "window" | "tab";
}

function ConnectionIndicator({
  isConnected,
  elapsed,
  tickCount,
}: {
  isConnected: boolean;
  elapsed: number;
  tickCount: number;
}) {
  return (
    <div
      className="flex items-center gap-1.5 text-[10px] text-text-subtle"
      data-testid="sysmon-connection"
      data-tick-count={tickCount}
    >
      {isConnected ? (
        <Wifi className="size-3 text-success" />
      ) : (
        <WifiOff className="size-3 text-error" />
      )}
      <span>{isConnected ? `Updated ${elapsed}s ago` : "Disconnected"}</span>
    </div>
  );
}

export const SystemMonitorBody = memo(function SystemMonitorBody({
  initialTab = "overview",
  onTabChange,
  variant = "tab",
}: SystemMonitorBodyProps) {
  const { latest, history, isConnected, tickCount } = useResourceMonitor({ processes: true });
  const [tab, setTab] = useState<SysMonTab>(initialTab);

  const selectTab = (next: SysMonTab) => {
    setTab(next);
    onTabChange?.(next);
  };

  const elapsed = latest ? Math.round((Date.now() - latest.ts) / 1000) : 0;
  const warnings = latest?.warnings ?? [];

  return (
    <div className="h-full flex flex-col overflow-hidden" data-testid="system-monitor-window">
      {variant === "tab" && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <h2 className="text-sm font-medium">System Monitor</h2>
          <ConnectionIndicator isConnected={isConnected} elapsed={elapsed} tickCount={tickCount} />
        </div>
      )}

      {warnings.length > 0 && (
        <div
          className="px-3 py-1.5 text-[11px] text-warning bg-warning/10 border-b border-border shrink-0 space-y-0.5"
          data-testid="sysmon-warnings"
        >
          {warnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {/* Sub-tab switcher */}
      <div className="flex items-center border-b border-border shrink-0" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "overview"}
          data-testid="sysmon-tab-overview"
          onClick={() => selectTab("overview")}
          className={cn(
            "flex-1 md:flex-none min-h-11 px-4 text-sm font-medium transition-colors",
            tab === "overview"
              ? "text-text-primary border-b-2 border-primary -mb-px"
              : "text-text-subtle hover:text-text-secondary",
          )}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "processes"}
          data-testid="sysmon-tab-processes"
          onClick={() => selectTab("processes")}
          className={cn(
            "flex-1 md:flex-none min-h-11 px-4 text-sm font-medium transition-colors",
            tab === "processes"
              ? "text-text-primary border-b-2 border-primary -mb-px"
              : "text-text-subtle hover:text-text-secondary",
          )}
        >
          Processes
        </button>
        {variant === "window" && (
          <div className="ml-auto pr-3">
            <ConnectionIndicator isConnected={isConnected} elapsed={elapsed} tickCount={tickCount} />
          </div>
        )}
      </div>

      {/* Body — scrolls internally, never the page */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Suspense fallback={<div className="p-4 text-xs text-text-subtle">Loading…</div>}>
          {!latest ? (
            <div className="flex items-center justify-center h-full text-text-subtle text-sm p-4">
              {isConnected ? "Waiting for data…" : "Connecting to resource monitor…"}
            </div>
          ) : tab === "overview" ? (
            <OverviewPanel system={latest.system} history={history} />
          ) : (
            <ProcessTable snapshot={latest} history={history} />
          )}
        </Suspense>
      </div>
    </div>
  );
});
