/**
 * Which column describes a row of a table in ⋯ Lookup, as DBGate's Customize sets it. Kept per
 * table and synced with the other UI prefs, because it is about the data rather than the screen:
 * a plan's name describes a plan on every device.
 *
 * Shared because the server's ui-prefs validator checks a stored copy against the same bounds the
 * browser writes it within.
 */

/** The column chosen, by the table's key (`lookupTableKey` in the browser). */
export type DbLookupDescriptions = Record<string, string>;

export const DB_LOOKUP_CAPS = { tables: 500, key: 1_000, column: 300 } as const;

const isKey = (k: string) => k.length > 0 && k.length <= DB_LOOKUP_CAPS.key;
const isColumn = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= DB_LOOKUP_CAPS.column;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored copy made usable: bad entries dropped, the most recently set kept. Null when it is not one at all. */
export function sanitizeLookupDescriptions(value: unknown): DbLookupDescriptions | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((e): e is [string, string] => isKey(e[0]) && isColumn(e[1]));
  return Object.fromEntries(entries.slice(-DB_LOOKUP_CAPS.tables));
}

/** The server's check on a copy a browser sends: the shape, within the bounds the browser keeps. */
export function isLookupDescriptions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= DB_LOOKUP_CAPS.tables && entries.every(([k, v]) => isKey(k) && isColumn(v));
}

/** The copy with one table's choice set, moved last so it is the one a full copy keeps. */
export function withLookupDescription(current: DbLookupDescriptions, key: string, column: string): DbLookupDescriptions {
  const { [key]: _old, ...rest } = current;
  return sanitizeLookupDescriptions({ ...rest, [key]: column }) ?? {};
}
