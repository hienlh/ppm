/**
 * Finder-flavoured unified titlebar: traffic lights left (grey when unfocused, hover
 * reveals the glyph), title centred, picture-in-picture at the right end. Height matches the
 * shared `TITLEBAR_HEIGHT` contract constant (not the real Finder 38px) so a minimised
 * window's collapsed height agrees with what `FloatingWindow` reserves for it.
 *
 * Worn by EVERY window kind, not just the explorer: the frame resolves one skin for all of
 * them. Anything below the titlebar (the explorer's own toolbar row, tinted by `skins.css`)
 * belongs to the window body — the chrome slot is only the titlebar itself.
 *
 * `data-skin` is set here (not only on the explorer body) because this titlebar is a
 * sibling of the body in the window tree — the `--x-*` vars it reads only resolve on an
 * element that itself carries the attribute.
 */

import { Minus, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { TITLEBAR_HEIGHT, type WindowChromeProps } from "@/components/floating-window/window-chrome-contract";
import { PipCaptionButton } from "@/components/floating-window/pip/pip-caption-button";

/** The traffic-light colours, plus the unfocused grey — the documented hardcoded hexes. */
const LIGHTS = [
  { color: "#FF5F57", label: "Close window", Icon: X },
  { color: "#FEBC2E", label: "Minimize window", Icon: Minus },
  { color: "#28C840", label: "Maximize window", Icon: Plus },
] as const;

export function MacosWindowChrome({
  id, title, focused, titlebarProps, onMinimize, onToggleMaximize, onClose,
}: WindowChromeProps) {
  const { className, style, ...rest } = titlebarProps;
  const actions = [onClose, onMinimize, onToggleMaximize];
  return (
    <div
      {...rest}
      data-skin="macos"
      style={{ height: TITLEBAR_HEIGHT, fontFamily: "var(--x-font)", ...style }}
      className={cn(
        "group/titlebar relative flex items-center shrink-0 rounded-t-[var(--x-radius)] overflow-hidden",
        "bg-[var(--x-titlebar-bg)] border-b border-border",
        "outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-inset",
        className,
      )}
    >
      <div className="flex items-center gap-2 pl-3">
        {LIGHTS.map(({ color, label, Icon }, i) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            onClick={actions[i]}
            className="grid size-3 place-items-center rounded-full"
            style={{ backgroundColor: focused ? color : "#8E8E93" }}
          >
            <Icon
              className="size-2 text-black/60 can-hover:opacity-0 can-hover:group-hover/titlebar:opacity-100"
              strokeWidth={3}
            />
          </button>
        ))}
      </div>
      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 truncate text-center text-[13px]",
          focused ? "text-text" : "text-text-2",
        )}
      >
        {title}
      </span>
      {/* `relative` on purpose: the centred title above is absolutely positioned and would
          otherwise paint over this button. Both positioned → DOM order decides, and this
          comes last. */}
      <div className="relative ml-auto flex items-center pr-2">
        <PipCaptionButton id={id} />
      </div>
    </div>
  );
}
