/**
 * The pure half of Settings → PPM Assistant → Changes: which rows a filter keeps, the badges that
 * say how a change came about, and why a row has no Undo. Testable without the stores.
 */
import type { SettingChangeView } from "../../../../shared/assistant-settings-changes";

export type ChangesFilter = "all" | "settings" | "installs" | "undone";

export function filterChanges(changes: readonly SettingChangeView[], filter: ChangesFilter): SettingChangeView[] {
  switch (filter) {
    case "all": return [...changes];
    case "settings": return changes.filter((c) => c.kind === "setting");
    case "installs": return changes.filter((c) => c.kind !== "setting");
    case "undone": return changes.filter((c) => c.undoneAt !== null || c.undoes !== null);
  }
}

export interface ChangeBadge { label: string; tone: "full" | "card" | "plain" }

export function changeHowBadges(c: SettingChangeView): ChangeBadge[] {
  const via: ChangeBadge = { label: c.origin === "telegram" ? "Telegram" : "PPM", tone: "plain" };
  const how: ChangeBadge = c.approval === "full"
    ? { label: "Full · no card", tone: "full" }
    : c.approval === "card" ? { label: "Allowed on card", tone: "card" } : { label: "Your undo", tone: "plain" };
  return c.undoes !== null ? [via, { label: `Undoes #${c.undoes}`, tone: "plain" }, how] : [via, how];
}

/** Why there is no Undo, as one line; null when Undo is offered. */
export function undoNote(c: SettingChangeView): string | null {
  if (!c.undo) return null;
  switch (c.undo.reason) {
    case "undone": return c.undoneAt ? `Undone ${new Date(c.undoneAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}.` : "Undone.";
    case "moved": return `Changed again since (now ${c.undo.current}) — can't undo.`;
    case "not_undoable": return c.kind === "setting" ? c.undo.detail : null;
  }
}
