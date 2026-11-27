/**
 * "Windows is ignoring input": shown while the host drops what this viewer sends because an app
 * running as administrator has focus there (Windows' UIPI; the host reports it as `inputBlocked`).
 * Without it the picture streams fine and the pointer simply does not move, with nothing to say
 * why — what a real host did with WireGuard's window in front. Shared by the desktop window and
 * the mobile viewer; it goes away by itself when input gets through again, and can be dismissed
 * until the next block.
 */
import { useEffect, useState } from "react";
import { ShieldAlert, X } from "@/lib/icons";
import { ICON_CONTROL_SIZE } from "@/lib/control-size";
import { cn } from "@/lib/utils";

export interface InputBlocked {
  /** File name of the administrator app in front, when the host could read it. */
  app: string | null;
}

/** The `blocked` field of an `inputBlocked` message; anything unexpected reads as "not blocked". */
export function parseInputBlocked(value: unknown): InputBlocked | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { reason?: unknown; app?: unknown };
  if (v.reason !== "elevated-window") return null;
  return { app: typeof v.app === "string" && v.app ? v.app : null };
}

export function inputBlockedText(app: string | null): string {
  return `Windows is ignoring input: ${app ?? "the window in front"} runs as administrator. `
    + "Bring another window to the front on the PC.";
}

export function RemoteDesktopInputBlockedBar({
  blocked,
  positionClassName = "absolute left-1/2 top-2 max-w-[92%] -translate-x-1/2",
}: {
  blocked: InputBlocked | null;
  positionClassName?: string;
}) {
  // Dismissed for this block only: a new one (another app, or after input got through) shows again.
  const [dismissed, setDismissed] = useState<InputBlocked | null>(null);
  useEffect(() => { if (!blocked) setDismissed(null); }, [blocked]);
  if (!blocked || (dismissed && dismissed.app === blocked.app)) return null;
  return (
    <div
      role="status"
      className={cn(
        "z-40 flex items-center gap-2 rounded-lg border border-amber-300/30 bg-black/85 px-3 py-2 text-xs text-amber-50 shadow-lg",
        positionClassName,
      )}
      data-testid="remote-desktop-input-blocked"
    >
      <ShieldAlert className="size-4 shrink-0 text-amber-300" />
      <span className="min-w-0 flex-1">{inputBlockedText(blocked.app)}</span>
      <button
        type="button"
        onClick={() => setDismissed(blocked)}
        aria-label="Dismiss"
        className={cn("inline-flex shrink-0 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white", ICON_CONTROL_SIZE)}
        data-testid="remote-desktop-input-blocked-dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
