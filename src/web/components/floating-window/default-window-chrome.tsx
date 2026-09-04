/**
 * Neutral titlebar used until an OS skin supplies its own chrome. Uses PPM semantic tokens
 * so it inherits the active theme instead of hard-coding a platform look.
 *
 * A chrome is a component, not a render callback: a skin is free to hold its own hover,
 * focus or animation state without entangling itself with the window frame's hooks.
 */

import type { ReactNode } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TITLEBAR_HEIGHT, type WindowChromeProps } from "./window-chrome-contract";

/**
 * Caption buttons follow the Windows metric (44 px wide) rather than a square 44 px touch
 * target: the window layer never renders below the `md` breakpoint, where mobile sheets
 * take over, so the titlebar can stay at desktop height.
 *
 * Exported so a kind-specific chrome that reuses this titlebar styles its extra button
 * identically instead of re-deriving the metric.
 */
export const CAPTION_BUTTON = "grid place-items-center w-11 self-stretch text-text-2 can-hover:hover:bg-surface-elevated can-hover:hover:text-text transition-colors";

/**
 * `children` are extra caption buttons, rendered left of minimize/maximize/close — a
 * wrapping chrome cannot reach inside this markup, and duplicating the whole titlebar to
 * add one button is how the two copies drift apart.
 */
export function DefaultWindowChrome({
  title,
  state,
  focused,
  titlebarProps,
  onMinimize,
  onToggleMaximize,
  onClose,
  children,
}: WindowChromeProps & { children?: ReactNode }) {
  const { className, style, ...rest } = titlebarProps;
  return (
    <div
      {...rest}
      style={{ height: TITLEBAR_HEIGHT, ...style }}
      className={cn(
        "flex items-stretch shrink-0 border-b border-border bg-panel-2 rounded-t-[8px] overflow-hidden",
        "outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset",
        className,
      )}
    >
      <div className="flex-1 min-w-0 flex items-center px-3 cursor-default">
        <span className={cn("truncate text-xs font-medium", focused ? "text-text" : "text-text-2")}>
          {title}
        </span>
      </div>
      {children}
      <button
        type="button"
        aria-label="Minimize window"
        className={CAPTION_BUTTON}
        onClick={onMinimize}
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={state === "maximized" ? "Restore window" : "Maximize window"}
        className={CAPTION_BUTTON}
        onClick={onToggleMaximize}
      >
        {state === "maximized" ? <Copy className="size-3" /> : <Square className="size-3" />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        className={cn(CAPTION_BUTTON, "can-hover:hover:bg-destructive can-hover:hover:text-white")}
        onClick={onClose}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
