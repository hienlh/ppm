/**
 * What DBGate's Save changes dialog for a grid's rows works out from the server's preview: the
 * script it shows — the DELETEs of every table ticked under "Delete references CASCADE" first,
 * as the server runs them, then the INSERTs, UPDATEs and DELETEs — the tables to send as the
 * cascade, and what it says once the changes are in. Pure, so it is tested without a browser.
 */
import type { ChangesetApplyResult, ChangesetPreview, ChangesetReference, TableRef } from "../../../../shared/db-changeset";

/** One name per table, schema included: two schemas can each hold an `orders`. */
export function refKey(ref: TableRef): string {
  return `${ref.schema ?? ""}.${ref.table}`;
}

/**
 * What the cascade ticks come to: nothing unless "Delete references CASCADE" is ticked, and then
 * every table but the ones unticked under it, in the preview's order — deepest first, which is
 * the order their deletes run in.
 */
export function cascadeTables(preview: Pick<ChangesetPreview, "references">, cascade: boolean, off: ReadonlySet<string>): ChangesetReference[] {
  return cascade ? preview.references.filter((r) => !off.has(refKey(r))) : [];
}

/** The script OK runs, as the server runs it: the ticked tables' DELETEs before the changes themselves. */
export function saveScript(preview: Pick<ChangesetPreview, "script">, ticked: readonly ChangesetReference[]): string {
  return [...ticked.map((r) => r.script), preview.script].filter((s) => s.length > 0).join("\n");
}

/** A referencing table as the list names it: with its schema only when that is not the saved table's. */
export function refLabel(ref: TableRef, schema: string | null): string {
  return ref.schema && ref.schema !== schema ? `${ref.schema}.${ref.table}` : ref.table;
}

/** How the table reaches the rows deleted: `order_items → orders → users`, one line per way. */
export function refPaths(ref: Pick<ChangesetReference, "paths">): string[] {
  return ref.paths.map((p) => p.join(" → "));
}

/** The toast once a save is in: every row it wrote, cascaded ones too. */
export function savedText(result: ChangesetApplyResult): string {
  const n = result.inserted + result.updated + result.deleted + result.cascaded;
  return `${n} change${n === 1 ? "" : "s"} saved in one transaction · ${result.executionTimeMs} ms`;
}

const DONT_ASK_KEY = "ppm-db-save-dont-ask";

/**
 * Whether Save shows its script first, on this device. Don't ask again covers only a save with
 * nothing to cascade: one that deletes rows other tables still point at always asks.
 */
export function gridSaveAsks(): boolean {
  try {
    return localStorage.getItem(DONT_ASK_KEY) !== "1";
  } catch {
    return true;
  }
}

export function stopAskingGridSave(): void {
  try {
    localStorage.setItem(DONT_ASK_KEY, "1");
  } catch {
    // Not kept: the next Save asks again.
  }
}
