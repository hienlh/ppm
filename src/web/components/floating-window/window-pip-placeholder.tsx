/**
 * What a floating window shows while its body is playing in a picture-in-picture window.
 *
 * It takes the body's place in the frame's flex column — the body element is physically gone
 * from here, so the two never fight over the space — and it stays in the MAIN document on
 * purpose: it is the way back. An empty frame would just read as lost content.
 */

import { cn } from "@/lib/utils";
import type { PipHandle } from "./pip/pip-host";

export function WindowPipPlaceholder({ pip, minimized }: { pip: PipHandle; minimized: boolean }) {
  return (
    <div
      className={cn(
        "relative flex-1 min-h-0 flex flex-col items-center justify-center gap-3",
        "rounded-b-[8px] bg-panel text-center px-4",
        minimized && "hidden",
      )}
    >
      <span className="text-xs text-text-2">Playing in picture-in-picture</span>
      <button
        type="button"
        onClick={() => pip.detach()}
        className="min-h-11 min-w-11 px-4 rounded-md border border-border bg-surface-elevated text-sm text-text can-hover:hover:bg-panel-2 transition-colors"
      >
        Bring back
      </button>
    </div>
  );
}
