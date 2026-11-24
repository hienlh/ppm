/**
 * Button sizes of PPM's browser UI, from `docs/design-guidelines.md` → Mobile-First rule 3 (the
 * chat footer's chip row is the standard): a button with text is 28px tall on desktop and 26px
 * on a phone; an icon button 24px (at least 26 wide) and 22px (at least 22 wide). No 44px
 * minimum and no invisible `::after` press area. Text inputs and list rows are not covered.
 */

const base = "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full transition-colors disabled:opacity-40 disabled:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0";

/** An icon-only toolbar button: 24px (26+ wide) on desktop, 22px square on a phone. */
export const WB_ICON_BUTTON = `${base} h-6 min-w-[26px] px-1.5 text-text-2 hover:bg-panel-2 hover:text-text max-md:h-[22px] max-md:min-w-[22px] max-md:px-1`;

/** A button or chip with text: 28px on desktop, 26px on a phone. */
export const WB_TEXT_BUTTON = `${base} h-7 gap-1.5 px-2.5 text-[11.5px] max-md:h-[26px] max-md:px-[5px]`;

export const WB_TEXT_BUTTON_PRIMARY = `${WB_TEXT_BUTTON} bg-primary text-white hover:opacity-90`;
export const WB_TEXT_BUTTON_OUTLINE = `${WB_TEXT_BUTTON} border border-border text-text hover:bg-panel-2`;
export const WB_TEXT_BUTTON_DANGER = `${WB_TEXT_BUTTON} text-destructive hover:bg-panel-2`;
