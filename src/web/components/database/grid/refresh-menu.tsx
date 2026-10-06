/**
 * DBGate's Refresh: the button reads the rows again, and ▾ beside it reads the table's structure
 * too, or refreshes on a timer. A timed refresh reads quietly — no "Loading data" box every
 * second, which is all anyone would see — and, like every refresh, keeps the unsaved changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, RefreshCw } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatCombo } from "@/stores/keybindings-store";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolButtonClass } from "../db-tab-parts";

/** The intervals ▾ offers, in seconds. */
export const AUTO_REFRESH_EVERY = [1, 5, 10, 15, 30, 60] as const;
/** What Start auto refresh uses until another interval is picked. */
const DEFAULT_EVERY = 10;

export interface AutoRefresh {
  running: boolean;
  /** Seconds between two refreshes: the one running, or the one Start uses next. */
  every: number;
  /** Starts refreshing, every `every` seconds when given. */
  start: (every?: number) => void;
  stop: () => void;
}

export interface RefreshMenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
}

/** ▾'s items, in DBGate's order. */
export function refreshMenuItems(refreshWithStructure: () => void, auto: AutoRefresh): RefreshMenuItem[] {
  return [
    { label: "Refresh with structure", shortcut: formatCombo("Mod+F5"), onSelect: refreshWithStructure },
    auto.running
      ? { label: "Stop auto refresh", shortcut: formatCombo("Mod+Shift+R"), onSelect: auto.stop }
      : { label: "Start auto refresh", shortcut: formatCombo("Mod+Shift+R"), onSelect: () => auto.start() },
    { label: "Refresh every 1 second", onSelect: () => auto.start(1) },
    ...AUTO_REFRESH_EVERY.slice(1).map((s) => ({ label: `...${s} seconds`, onSelect: () => auto.start(s) })),
  ];
}

export const refreshLabel = (auto: AutoRefresh) => (auto.running ? `Refresh (every ${auto.every}s)` : "Refresh");

/**
 * Refreshes every few seconds while running. A tick is skipped while `canRun` says no — the tab
 * is not on screen, or rows are being read — and while the previous refresh is still out. One that
 * fails stops the timer and says why, rather than failing again every second.
 */
export function useAutoRefresh(refresh: () => Promise<Error | null>, canRun: () => boolean): AutoRefresh {
  const [running, setRunning] = useState(false);
  const [every, setEvery] = useState(DEFAULT_EVERY);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const canRunRef = useRef(canRun);
  canRunRef.current = canRun;

  useEffect(() => {
    if (!running) return;
    let out = false;
    let stopped = false;
    const timer = setInterval(() => {
      if (out || document.hidden || !canRunRef.current()) return;
      out = true;
      void refreshRef.current().then((error) => {
        out = false;
        if (!error || stopped) return;
        setRunning(false);
        toast.error("Auto refresh stopped", { description: error.message });
      });
    }, every * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, every]);

  const start = useCallback((seconds?: number) => {
    if (seconds !== undefined) setEvery(seconds);
    setRunning(true);
  }, []);
  const stop = useCallback(() => setRunning(false), []);
  return { running, every, start, stop };
}

/** The toolbar's Refresh and its ▾, one split button. */
export function RefreshButton({ onRefresh, onRefreshWithStructure, auto, busy, disabled, form }: {
  onRefresh: () => void;
  onRefreshWithStructure: () => void;
  auto: AutoRefresh;
  /** Rows are being read: the icon turns. */
  busy?: boolean;
  disabled?: boolean;
  /** The form view's, as DBGate titles it. */
  form?: boolean;
}) {
  const label = refreshLabel(auto);
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button" onClick={onRefresh} disabled={disabled} aria-label={label}
        title={`${form ? "Data form" : "Data grid"}: Refresh (F5 | ${formatCombo("Mod+R")})`}
        className={cn(toolButtonClass, "rounded-r-none pr-1", busy && "[&>svg]:animate-spin")}
      >
        <RefreshCw className="size-4 shrink-0" />
        <span className="@max-[900px]:hidden">{label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button" disabled={disabled} aria-label="Refresh options" title="Refresh options"
            className={cn(toolButtonClass, "rounded-l-none px-0.5")}
          >
            <ChevronDown className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          {refreshMenuItems(onRefreshWithStructure, auto).map((item) => (
            <DropdownMenuItem key={item.label} onSelect={item.onSelect}>
              {item.label}
              {item.shortcut && <DropdownMenuShortcut className="tracking-normal">{item.shortcut}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
