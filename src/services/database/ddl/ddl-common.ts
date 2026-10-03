/**
 * Pieces every engine's DDL generator shares: what counts as an empty field, and the names Save
 * gives a key or index the user left unnamed.
 */
import { autoConstraintName, columnName, type TableModel } from "../../../shared/db-table-model.ts";

/** An empty field in a dialog means "none", as a missing value does. */
export function filled(value: string | null | undefined): string | null {
  const t = value?.trim() ?? "";
  return t === "" ? null : t;
}

/**
 * Names for the keys and indexes a script creates: the user's, or DBGate's `PK_<table>`,
 * `FK_<table>_<cols>`, `IX_…`, `UQ_…` — made unique against every name the table still holds,
 * since two indexes on the same columns would otherwise be given one name.
 */
export class ConstraintNamer {
  private readonly used = new Set<string>();

  constructor(private readonly model: TableModel, private readonly caseless: boolean, keep: Iterable<string> = []) {
    for (const name of keep) this.used.add(this.key(name));
  }

  private key(name: string): string {
    return this.caseless ? name.toLowerCase() : name;
  }

  /** The item's own name if it has one, else a generated one; either way reserved from now on. */
  name(kind: "PK" | "FK" | "IX" | "UQ", given: string | null | undefined, columnIds: readonly (string | null)[]): string {
    const own = filled(given);
    if (own) {
      this.used.add(this.key(own));
      return own;
    }
    const base = autoConstraintName(kind, this.model.name, columnIds.map((id) => (id === null ? "expr" : columnName(this.model, id))));
    let candidate = base;
    for (let n = 2; this.used.has(this.key(candidate)); n++) candidate = `${base}_${n}`;
    this.used.add(this.key(candidate));
    return candidate;
  }
}

/** Is `name` a plain identifier, safe to write without quotes (an index method, an operator class, a MySQL engine)? */
export function isPlainWord(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
