import type { CallPpmRoute, RouteCallResult } from "../assistant-mcp/assistant-route-rules.ts";
import type { SettingChangeApproval, SettingChangeOrigin, SettingChangeRow, SettingUndoBlock } from "../../shared/assistant-settings-changes.ts";
import { lookupSetting } from "./settings-catalog.ts";
import { checkValue, formatValue, sameValue, type SettingEntry } from "./settings-catalog-types.ts";
import { claimSettingChangeUndo, getSettingChange, markSettingChangeUndone, recordSettingChange, releaseSettingChangeUndo } from "./settings-change-log.ts";

/**
 * Writing one setting through its pane's route, and undoing a change the Assistant made. Shared
 * by the tools (which ask first), the Changes tab and Telegram (where the user's own press is the
 * approval). Every write is compare-and-set: what was shown is read again just before, and a value
 * that moved in between is left alone.
 */

/** Calls the route that stores `value` for `entry`. A GET or DELETE carries no body. */
export async function writeSetting(callRoute: CallPpmRoute, entry: SettingEntry, value: unknown): Promise<RouteCallResult> {
  const call = await entry.write(value);
  const bodyless = call.method === "GET" || call.method === "DELETE";
  return callRoute(call.method, call.path, bodyless ? undefined : call.body);
}

export const routeError = (r: RouteCallResult): string => r.error ?? `PPM answered ${r.status}`;

/** Why `row` cannot be undone now, or null when it can. */
export async function undoBlockFor(row: SettingChangeRow): Promise<SettingUndoBlock | null> {
  if (row.undoneAt !== null) return { reason: "undone" };
  if (row.undoes !== null) return { reason: "not_undoable", detail: "It put an earlier change back; change the setting again instead." };
  if (row.kind === "install") return { reason: "not_undoable", detail: "Remove it with Uninstall instead." };
  if (row.kind === "uninstall") return { reason: "not_undoable", detail: "Install it again instead." };
  if (row.before === null) return { reason: "not_undoable", detail: "It had no value before this change." };
  const found = lookupSetting(row.key);
  if (found.kind !== "setting") return { reason: "not_undoable", detail: "This setting can no longer be changed from here." };
  if (!checkValue(found.entry, row.before).ok) return { reason: "not_undoable", detail: "The old value is no longer a valid one." };
  const current = await found.entry.read();
  if (!sameValue(current, row.after)) return { reason: "moved", current: formatValue(found.entry, current) };
  return null;
}

export type UndoOutcome =
  | { ok: true; row: SettingChangeRow; undone: SettingChangeRow }
  | { ok: false; error: string; block?: SettingUndoBlock };

/**
 * Puts row `id`'s old value back, as the user (a button) or after a card the caller already got
 * through. Records the undo as its own row and marks the original.
 */
export async function undoSettingChange(
  id: number,
  opts: { callRoute: CallPpmRoute; approval: SettingChangeApproval; origin: SettingChangeOrigin; sessionId: string | null },
): Promise<UndoOutcome> {
  const row = getSettingChange(id);
  if (!row) return { ok: false, error: "There is no such change." };
  const block = await undoBlockFor(row);
  if (block) return { ok: false, error: undoBlockText(block), block };
  const found = lookupSetting(row.key);
  if (found.kind !== "setting") return { ok: false, error: "This setting can no longer be changed from here." };
  // Claimed first, so a second press (the chat card and Telegram at once) does nothing.
  if (!claimSettingChangeUndo(row.id)) return { ok: false, error: undoBlockText({ reason: "undone" }), block: { reason: "undone" } };
  const r = await writeSetting(opts.callRoute, found.entry, row.before);
  if (!r.ok) {
    releaseSettingChangeUndo(row.id);
    return { ok: false, error: `It was not undone: ${routeError(r)}` };
  }
  const undo = recordSettingChange({
    sessionId: opts.sessionId, origin: opts.origin, approval: opts.approval, kind: "setting", key: row.key, label: row.label,
    before: row.after, after: row.before, beforeText: row.afterText, afterText: row.beforeText, undoes: row.id,
  });
  markSettingChangeUndone(row.id, undo.id);
  return { ok: true, row: undo, undone: { ...row, undoneAt: undo.at, undoneBy: undo.id } };
}

export function undoBlockText(block: SettingUndoBlock): string {
  switch (block.reason) {
    case "undone": return "That change was already undone.";
    case "moved": return `It was changed again since (now ${block.current}), so it is left as it is.`;
    case "not_undoable": return block.detail;
  }
}
