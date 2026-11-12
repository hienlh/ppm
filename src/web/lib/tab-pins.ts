/**
 * Pinned tabs, as VS Code has them: a pinned tab sits at the start of its tab bar, and the bulk
 * closes (Close Others, Close to the Right, Close Saved, Close All) leave it open. Only its own
 * Close, from the menu, closes it. Kept free of the stores so the rules are testable on their own.
 */
import type { Tab } from "@/stores/tab-store";

type PinTab = Pick<Tab, "id" | "closable" | "pinned">;

/** Pinned tabs first, each group in its own order. */
export function pinnedFirst<T extends Pick<Tab, "pinned">>(tabs: T[]): T[] {
  const pinned = tabs.filter((t) => t.pinned);
  if (pinned.length === 0 || pinned.length === tabs.length) return tabs;
  return [...pinned, ...tabs.filter((t) => !t.pinned)];
}

/**
 * Pins or unpins `tabId`. A pinned tab joins the end of the pinned group; an unpinned one becomes
 * the first unpinned tab, right after the pins, which is where VS Code puts both.
 */
export function withPinned<T extends Pick<Tab, "id" | "pinned">>(tabs: T[], tabId: string, pinned: boolean): T[] {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !!tab.pinned === pinned) return tabs;
  const rest = tabs.filter((t) => t.id !== tabId);
  const { pinned: _drop, ...plain } = tab;
  const next = (pinned ? { ...plain, pinned: true } : plain) as T;
  const at = rest.filter((t) => t.pinned).length;
  return [...rest.slice(0, at), next, ...rest.slice(at)];
}

export type BulkClose = "others" | "right" | "saved" | "all";

/** The tab menu's action names for each bulk close. */
export const BULK_CLOSE: Record<string, BulkClose> = {
  "close-others": "others",
  "close-right": "right",
  "close-saved": "saved",
  "close-all": "all",
};

/**
 * The tabs a bulk close takes, in bar order: never a pinned tab, never one that cannot close, and
 * for Close Saved never one holding unsaved work. `anchorId` is the tab the menu was opened on.
 */
export function bulkCloseIds<T extends PinTab>(
  tabs: T[], anchorId: string, kind: BulkClose, hasUnsaved: (t: T) => boolean,
): string[] {
  let pool = tabs;
  if (kind === "others") pool = tabs.filter((t) => t.id !== anchorId);
  if (kind === "right") pool = tabs.slice(tabs.findIndex((t) => t.id === anchorId) + 1);
  return pool
    .filter((t) => t.closable && !t.pinned && (kind !== "saved" || !hasUnsaved(t)))
    .map((t) => t.id);
}
