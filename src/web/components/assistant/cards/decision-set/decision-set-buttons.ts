/**
 * The set's buttons, at the app's button standard: a button with text is 28px tall (26px on a
 * phone), a small icon button 24px (22px). Pick by what the control is, never by the device.
 */
const BASE =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-40 max-md:h-[26px] max-md:px-2 [&_svg]:size-3.5 [&_svg]:shrink-0";

export const SET_BUTTON = {
  /** Send all, Send anyway: amber tint, a full amber outline and amber ink, set in bold. */
  primary: `${BASE} border border-warning bg-warning/20 font-semibold text-warning-ink can-hover:enabled:hover:bg-warning/30`,
  /** Sends one card: amber outline, no fill. */
  outline: `${BASE} border border-warning/70 text-warning-ink can-hover:enabled:hover:bg-warning/10`,
  /** Prev, Next, Back. */
  plain: `${BASE} border border-border bg-background text-text-primary can-hover:enabled:hover:bg-surface-elevated`,
  /** Open chat, Dismiss: quiet. */
  ghost: `${BASE} text-text-secondary can-hover:enabled:hover:bg-surface-elevated can-hover:enabled:hover:text-text-primary`,
} as const;

export const SET_ICON_BUTTON =
  "inline-grid h-6 min-w-[26px] shrink-0 place-items-center rounded-full text-text-secondary transition-colors " +
  "can-hover:enabled:hover:bg-surface-elevated can-hover:enabled:hover:text-text-primary disabled:opacity-40 " +
  "max-md:h-[22px] max-md:min-w-[22px] [&_svg]:size-3.5";
