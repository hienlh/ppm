/**
 * Class names shared by the chat footer's context row, so the chips on its left and the icon
 * buttons on its right keep one size, one press and one narrow behaviour.
 *
 * Icons are 14px in this row (the usage rings 12px). Below `md` the chips keep their drawn size and widen their hit area
 * with an invisible `::after` to the 44px a thumb needs, which is why they are `relative` — the
 * popover they open is their sibling, never their child, so this does not move it.
 */

/** A bordered chip on the left of the row: changes, linked sessions, connection. */
export const FOOTER_CHIP =
  "relative inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border-soft bg-panel-2 px-2.5 text-[11.5px] text-text-2 " +
  "transition-[background-color,color,border-color,transform] duration-150 motion-safe:active:scale-[0.97] " +
  "can-hover:hover:border-border can-hover:hover:text-text " +
  "aria-expanded:border-accent-wash-border aria-expanded:bg-accent-wash aria-expanded:text-text " +
  "md:@max-[420px]/chat:h-8 @max-[420px]/chat:px-2 max-md:h-[26px] max-md:px-[5px] " +
  // 10px: an absolute child is placed against the padding box, inside the 1px border, so the 26px
  // phone chip is 24px to the pseudo-element and needs 10px each side to answer a 44px press.
  "max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-2.5 max-md:after:content-[''] " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/**
 * The right of the row is one chip-shaped group — usage, History, ··· — with the left chips'
 * background, border, radius and height, so it stays anchored when the left side is empty.
 */
export const FOOTER_CLUSTER =
  "ml-auto flex h-7 shrink-0 items-center rounded-full border border-border-soft bg-panel-2 px-0.5 " +
  "md:@max-[420px]/chat:h-8 max-md:h-[26px] max-md:px-px";

/** A borderless button inside that group: usage, History, ···. */
export const FOOTER_GHOST =
  "relative inline-flex h-6 min-w-[26px] shrink-0 items-center justify-center gap-[5px] whitespace-nowrap rounded-full px-1.5 text-[11px] text-text-3 " +
  "transition-[background-color,color,transform] duration-150 motion-safe:active:scale-[0.97] " +
  "can-hover:hover:bg-surface-hover can-hover:hover:text-text aria-expanded:bg-surface-hover aria-expanded:text-text " +
  "md:@max-[420px]/chat:h-7 md:@max-[420px]/chat:min-w-[30px] max-md:h-[22px] max-md:min-w-[22px] max-md:px-1 " +
  // 22px square inside the 26px group on a phone: 11px above and below reach the 44px a thumb
  // needs. Sideways only 4px, so History and ··· never reach each other's middle (the later one
  // would take that press).
  "max-md:after:absolute max-md:after:-inset-x-1 max-md:after:-inset-y-[11px] max-md:after:content-[''] " +
  "[&_svg]:size-3.5 [&_svg]:shrink-0";

/** Words a narrow chat drops, keeping the counts and icons. */
export const HIDE_NARROW = "@max-[420px]/chat:hidden max-md:hidden";
