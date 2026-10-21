/**
 * Small shared pieces of the reviewer page's markup: class joining and the button looks.
 * Every target is at least 44px on every side, on a phone and on a desktop alike.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const BUTTON = "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium select-none disabled:opacity-50";

export const buttonPrimary = `${BUTTON} bg-primary text-primary-fg active:opacity-80 can-hover:hover:opacity-90`;
export const buttonQuiet = `${BUTTON} text-text-2 active:bg-panel-2 can-hover:hover:bg-panel-2`;
export const buttonOutline = `${BUTTON} border border-border bg-panel text-text active:bg-panel-2 can-hover:hover:bg-panel-2`;
export const buttonToggleOn = "bg-panel-2 text-text ring-1 ring-border";

export const fieldClass = "w-full rounded-lg border border-border bg-panel px-3 py-2 text-base text-text placeholder:text-text-3 md:text-sm";

/** A date as the reviewer's own locale writes it. */
export function formatDate(value: number | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
