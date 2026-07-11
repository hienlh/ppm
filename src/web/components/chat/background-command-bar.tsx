import { Loader2, Eye, Square, TerminalSquare } from "lucide-react";
import type { BackgroundShell } from "../../../types/api";
import { useBackgroundOutputStore } from "@/stores/background-output-store";

interface BackgroundCommandBarProps {
  shells: BackgroundShell[];
  onKill: (shellId: string) => void;
}

/** Pinned bar at the top of the chat listing the session's active background commands. */
export function BackgroundCommandBar({ shells, onKill }: BackgroundCommandBarProps) {
  const openPanel = useBackgroundOutputStore((s) => s.openPanel);
  const active = shells.filter((s) => s.status !== "stopped");
  if (active.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border bg-surface-elevated/60 px-2 py-1.5 space-y-1">
      {active.map((shell) => (
        <div key={shell.shellId} className="flex items-center gap-2 text-xs">
          {shell.status === "stopping" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-warning" />
          ) : (
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
          )}
          <TerminalSquare className="size-3.5 shrink-0 text-text-secondary" />
          <span className="flex-1 truncate font-mono text-text-primary" title={shell.command}>
            {shell.command}
          </span>
          {shell.status === "stopping" && <span className="text-[11px] text-warning shrink-0">stopping…</span>}
          <button
            type="button"
            onClick={() => openPanel(shell.shellId)}
            className="flex items-center justify-center size-8 rounded hover:bg-surface text-text-secondary hover:text-text-primary transition-colors"
            aria-label="View output"
            title="View output"
          >
            <Eye className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onKill(shell.shellId)}
            disabled={shell.status === "stopping"}
            className="flex items-center justify-center size-8 rounded hover:bg-surface text-text-secondary hover:text-error transition-colors disabled:opacity-40"
            aria-label="Stop command"
            title="Stop command"
          >
            <Square className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
