/**
 * Shared shell for the System Monitor: connection indicator, warning strip, and the
 * sub-tabs. Rendered identically by the desktop window and the mobile tab, so this
 * file and the panels beneath it are written once for both hosts.
 *
 * The five tabs follow Mission Center's own division — Performance, Apps,
 * Processes, Services — with PPM's existing Overview kept as the default, because
 * a one-screen summary is what most opens of this window are for.
 */
import { lazy, memo, Suspense, useState } from "react";
import { Settings, Wifi, WifiOff } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useResourceMonitor } from "@/hooks/use-resource-monitor";
import { SysMonPreferences } from "./sysmon-preferences";

const OverviewPanel = lazy(() =>
  import("./overview-panel").then((m) => ({ default: m.OverviewPanel })),
);
const PerformancePanel = lazy(() =>
  import("./performance/performance-panel").then((m) => ({ default: m.PerformancePanel })),
);
const AppsPanel = lazy(() =>
  import("./apps/apps-panel").then((m) => ({ default: m.AppsPanel })),
);
const ProcessTable = lazy(() =>
  import("./process-table").then((m) => ({ default: m.ProcessTable })),
);
const ServicesPanel = lazy(() =>
  import("./services/services-panel").then((m) => ({ default: m.ServicesPanel })),
);

export const SYSMON_TABS = ["overview", "performance", "apps", "processes", "services"] as const;
export type SysMonTab = (typeof SYSMON_TABS)[number];

const TAB_LABELS: Record<SysMonTab, string> = {
  overview: "Overview",
  performance: "Performance",
  apps: "Apps",
  processes: "Processes",
  services: "Services",
};

/** A tab id off a persisted window payload is untrusted the same way one off the
 *  wire is — an unknown value falls back rather than rendering nothing. */
export function parseSysMonTab(value: unknown): SysMonTab {
  return SYSMON_TABS.includes(value as SysMonTab) ? (value as SysMonTab) : "overview";
}

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
  const [prefsOpen, setPrefsOpen] = useState(false);
  // The Performance page's selected device lives here rather than in that panel,
  // because an Overview card has to be able to set it on the way in. `null` is
  // "nothing chosen" — the desktop sidebar falls back to its first entry and the
  // phone shows the device list, which is what both did before.
  const [device, setDevice] = useState<string | null>(null);

  const selectTab = (next: SysMonTab) => {
    setTab(next);
    onTabChange?.(next);
  };

  /** An Overview card was clicked: select its device, then show Performance. */
  const openDevice = (key: string) => {
    setDevice(key);
    selectTab("performance");
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

      {/* Sub-tab switcher. Five tabs no longer fit a phone, so the strip scrolls
          sideways rather than wrapping to a second row that would eat the list. */}
      <div className="flex items-center border-b border-border shrink-0 overflow-x-auto" role="tablist">
        {SYSMON_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`sysmon-tab-${id}`}
            onClick={() => selectTab(id)}
            className={cn(
              "shrink-0 min-h-11 px-4 text-sm font-medium transition-colors",
              tab === id
                ? "text-text-primary border-b-2 border-primary -mb-px"
                : "text-text-subtle hover:text-text-secondary",
            )}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pl-3 pr-1 shrink-0">
          {variant === "window" && (
            <ConnectionIndicator isConnected={isConnected} elapsed={elapsed} tickCount={tickCount} />
          )}
          <button
            type="button"
            aria-label="System Monitor preferences"
            aria-expanded={prefsOpen}
            onClick={() => setPrefsOpen((open) => !open)}
            data-testid="sysmon-prefs-toggle"
            className={cn(
              "flex items-center justify-center size-11 md:size-8 rounded transition-colors",
              prefsOpen ? "text-primary bg-primary/10" : "text-text-subtle hover:text-text-secondary hover:bg-surface-hover",
            )}
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>

      {prefsOpen && <SysMonPreferences />}

      {/* Body — scrolls internally, never the page. Services is the one tab that
          does not wait on `latest`: it has its own endpoint and would otherwise be
          blank on a host where the metrics stream is the thing that is broken. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Suspense fallback={<div className="p-4 text-xs text-text-subtle">Loading…</div>}>
          {tab === "services" ? (
            <ServicesPanel active metrics={latest} />
          ) : !latest ? (
            <div className="flex items-center justify-center h-full text-text-subtle text-sm p-4">
              {isConnected ? "Waiting for data…" : "Connecting to resource monitor…"}
            </div>
          ) : tab === "overview" ? (
            <OverviewPanel system={latest.system} history={history} onOpenDevice={openDevice} />
          ) : tab === "performance" ? (
            <PerformancePanel
              system={latest.system}
              history={history}
              device={device}
              onDeviceChange={setDevice}
            />
          ) : tab === "apps" ? (
            <AppsPanel snapshot={latest} />
          ) : (
            <ProcessTable snapshot={latest} />
          )}
        </Suspense>
      </div>
    </div>
  );
});
