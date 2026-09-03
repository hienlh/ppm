/**
 * Shared square icon-button styling for the window toolbar and any trigger that sits
 * alongside it (e.g. the sort menu button) — one class builder keeps their hit-box
 * behaviour identical instead of two toolbars drifting apart.
 *
 * The visible box stays `size-7` (28px) on every pointer type — only the tap-registering
 * area grows to the 44px minimum on a coarse pointer, via an invisible expanded `::before`
 * (a click anywhere in it still hits this element; nothing about the button's look moves).
 */

import { cn } from "@/lib/utils";

export function toolbarButtonClass(coarse: boolean): string {
  return cn(
    "relative flex size-7 shrink-0 items-center justify-center rounded text-text-subtle can-hover:hover:bg-surface-elevated can-hover:hover:text-text disabled:opacity-30",
    coarse && "before:absolute before:-inset-2 before:content-['']",
  );
}
