/**
 * Windows 11 File Explorer-flavoured titlebar: window icon + title left, caption buttons
 * right (46×32, close hover red). The toolbar row (back/forward/breadcrumb/search) is the
 * existing `ExplorerToolbar` in the window body, tinted by `skins.css` — the chrome slot is
 * only the titlebar itself.
 */

import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WindowChromeProps } from "@/components/floating-window/window-chrome-contract";
import { WindowsFolderIcon } from "./folder-icon-windows";

const TITLEBAR_HEIGHT = 32;
/** Windows metric: 46px wide caption buttons, full titlebar height. */
const CAPTION_BUTTON =
  "grid place-items-center w-[46px] self-stretch text-text-2 can-hover:hover:bg-surface-elevated can-hover:hover:text-text transition-colors";
/** The one documented hardcoded hex: Windows' close-button hover red. */
const CLOSE_BUTTON = cn(CAPTION_BUTTON, "can-hover:hover:!bg-[#c42b1c] can-hover:hover:!text-white");

export function WindowsWindowChrome({
  title, state, focused, titlebarProps, onMinimize, onToggleMaximize, onClose,
}: WindowChromeProps) {
  const { className, style, ...rest } = titlebarProps;
  return (
    <div
      {...rest}
      style={{ height: TITLEBAR_HEIGHT, fontFamily: "var(--x-font)", ...style }}
      className={cn(
        "flex items-stretch shrink-0 rounded-t-[var(--x-radius)] overflow-hidden",
        "bg-[var(--x-titlebar-bg)] border-b border-border",
        "outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset",
        className,
      )}
    >
      <div className="flex flex-1 min-w-0 items-center gap-2 px-2.5 cursor-default">
        <WindowsFolderIcon className="size-4 shrink-0" />
        <span className={cn("truncate text-[12px]", focused ? "text-text" : "text-text-2")}>{title}</span>
      </div>
      <button type="button" aria-label="Minimize window" className={CAPTION_BUTTON} onClick={onMinimize}>
        <Minus className="size-3.5" />
      </button>
      <button type="button" aria-label={state === "maximized" ? "Restore window" : "Maximize window"} className={CAPTION_BUTTON} onClick={onToggleMaximize}>
        {state === "maximized" ? <Copy className="size-3" /> : <Square className="size-3" />}
      </button>
      <button type="button" aria-label="Close window" className={CLOSE_BUTTON} onClick={onClose}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
