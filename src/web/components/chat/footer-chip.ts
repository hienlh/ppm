/**
 * Class names shared by the chat footer's context row, so the chips on its left and the icon
 * buttons on its right keep one size, one press and one narrow behaviour.
 *
 * Icons are 14px in this row. Below `md` the chips keep their drawn size and widen their hit area
 * with an invisible `::after` to the 44px a thumb needs, which is why they are `relative` — the
 * popover they open is their sibling, never their child, so this does not move it.
 */

/** A bordered chip on the left of the row: changes, linked sessions, connection. */
export const FOOTER_CHIP =
  "relative inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-2.5 text-[11.5px] text-text-2 " +
  "transition-[background-color,color,border-color,transform] duration-150 motion-safe:active:scale-[0.97] " +
  "can-hover:hover:border-border can-hover:hover:text-text " +
  "aria-expanded:border-accent-wash-border aria-expanded:bg-accent-wash aria-expanded:text-text " +
  "md:@max-[420px]/chat:h-8 @max-[420px]/chat:px-2 max-md:h-7 max-md:px-2 " +
  // 9px: an absolute child is placed against the padding box, inside the 1px border, so the 28px
  // phone chip is 26px to the pseudo-element and needs 9px each side to answer a 44px press.
  "max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-[9px] max-md:after:content-[''] " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/** A borderless icon button on the right of the row: usage, History, ···. */
export const FOOTER_GHOST =
  "relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-[5px] whitespace-nowrap rounded-lg px-1.5 text-[11px] text-text-3 " +
  "transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] " +
  "can-hover:hover:bg-surface-hover can-hover:hover:text-text aria-expanded:bg-surface-hover aria-expanded:text-text " +
  "md:@max-[420px]/chat:h-8 md:@max-[420px]/chat:min-w-8 max-md:h-7 max-md:min-w-7 " +
  // 28px drawn, 44px to a thumb: no border here, so 8px each side is the whole 16.
  "max-md:after:absolute max-md:after:-inset-2 max-md:after:content-[''] " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/** Words a narrow chat drops, keeping the counts and icons. */
export const HIDE_NARROW = "@max-[420px]/chat:hidden max-md:hidden";
