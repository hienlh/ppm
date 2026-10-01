/**
 * A process row's actions — Mission Center's right-click menu: Details, End, and
 * the Send Signal submenu.
 *
 * Right-click on a mouse, long-press on a touch screen, via the adaptive menu.
 * That component only SUPPRESSES the click following a long press; it has no tap
 * handler of its own, so the row's own tap target stays a real button inside the
 * trigger and is passed through as `children` untouched.
 */
import type { ReactNode } from "react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { SIGNAL_LABELS, UNCATCHABLE_SIGNALS } from "./use-process-signal";
import type { ProcessInfo, ProcessSignal } from "../../../types/system-metrics";

export interface ProcessRowMenuProps {
  proc: ProcessInfo;
  /** Signals this host can deliver, straight off the snapshot. Empty or absent
   *  hides the submenu entirely rather than offering something that would 400. */
  signals: readonly ProcessSignal[];
  onDetails: (proc: ProcessInfo) => void;
  onKill: (proc: ProcessInfo) => void;
  onSignal: (proc: ProcessInfo, signal: ProcessSignal, tree: boolean) => void;
  children: ReactNode;
}

export function ProcessRowMenu({
  proc, signals, onDetails, onKill, onSignal, children,
}: ProcessRowMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="select-none">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onDetails(proc)}>Details…</ContextMenuItem>
        {signals.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>Send signal</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {signals.map((signal) => (
                <ContextMenuItem
                  key={signal}
                  variant={UNCATCHABLE_SIGNALS.includes(signal) ? "destructive" : undefined}
                  disabled={proc.protected}
                  onSelect={() => { if (!proc.protected) onSignal(proc, signal, false); }}
                >
                  {SIGNAL_LABELS[signal]}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={proc.protected}
          onSelect={() => { if (!proc.protected) onKill(proc); }}
        >
          End process
        </ContextMenuItem>
        {proc.protected && (
          <p className="px-2 py-1.5 text-[11px] text-text-subtle max-w-64">
            PPM or OS-critical process — it cannot be ended or signalled.
          </p>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
