/**
 * Configure columns, applied: which source column each written column takes, and under what name.
 * An empty mapping copies every column as it is, as DBGate says in its dialog.
 */
import { columnMapProblem, type ColumnMapEntry } from "../../../shared/db-impexp.ts";

export class ColumnMapError extends Error {}

export interface MappedColumns {
  /** For each written column, the index of the source column it takes. */
  indexes: number[];
  /** What each written column is called. */
  names: string[];
}

/**
 * The columns a row writes, from the `source` columns it is read with. Throws `ColumnMapError` for
 * a mapping that cannot be used — the dialog's own checks — or one naming a column `source` lacks;
 * `what` names the source in that message.
 */
export function mapColumns(source: readonly string[], entries: readonly ColumnMapEntry[] | undefined, what: string): MappedColumns {
  if (!entries?.length) return { indexes: source.map((_, i) => i), names: [...source] };
  const problem = columnMapProblem(entries);
  if (problem) throw new ColumnMapError(problem);
  const used = entries.filter((e) => !e.skip);
  if (!used.length) throw new ColumnMapError("No column is used: tick at least one in Configure columns");
  const indexes = used.map((e) => {
    const index = source.indexOf(e.src);
    if (index < 0) throw new ColumnMapError(`Column "${e.src}" is not in ${what}`);
    return index;
  });
  return { indexes, names: used.map((e) => e.dst) };
}

/**
 * Column names made fit to map and to write: an empty one is `col<N>` (its 1-based place), and one
 * already taken gets the first free `_1`, `_2`… A query naming two columns alike (`a.id, b.id`)
 * would otherwise write a JSON object holding one of them twice, which readers keep only once of.
 */
export function uniqueColumnNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name, i) => {
    let unique = name || `col${i + 1}`;
    for (let n = 1; taken.has(unique); n++) unique = `${name || `col${i + 1}`}_${n}`;
    taken.add(unique);
    return unique;
  });
}

/** True when the mapping writes the source's columns unchanged, in order: rows need not be copied. */
export function isIdentity(mapped: MappedColumns, sourceLength: number): boolean {
  return mapped.indexes.length === sourceLength && mapped.indexes.every((index, i) => index === i);
}

/** One row as the mapping writes it. */
export function pickRow(row: readonly unknown[], indexes: readonly number[]): unknown[] {
  return indexes.map((i) => row[i]);
}
