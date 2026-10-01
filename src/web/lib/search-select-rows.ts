/**
 * The rows a searchable select shows for one query.
 *
 * Pure, and in `lib` rather than beside the component, because importing the
 * component reaches the sheet's hooks, which want a DOM — the decisions here are
 * testable without one.
 *
 * The match is a case-insensitive substring of the whole label, the same one the
 * checkout quick pick makes. Not a prefix: the lists this serves are names that
 * agree for most of their length — `fix/NX-5175-…` branches, `nxsys-backend-nx5833`
 * checkouts — and the part anyone types is the part that differs.
 *
 * A heading is emitted only when something under it survived the filter, the rule
 * `git-ref-picker.ts` follows too: a heading over nothing reads as a list that failed
 * to load. Groups keep the order they first appear in over the *whole* list, so a
 * filter that empties the first group does not reorder the rest.
 */
import type { ElementType } from "react";

export interface SearchSelectItem {
  value: string;
  /** Shown on the row and on the trigger, and what the filter matches. */
  label: string;
  /** The heading this row is listed under. Items with none get no heading. */
  group?: string;
  icon?: ElementType;
  /** Short muted text at the end of the row — `current`, say. */
  hint?: string;
  /** Tooltip, for when the label is a shortened form of something longer. */
  title?: string;
}

export type SearchSelectRow =
  | { kind: "separator"; label: string }
  | { kind: "item"; item: SearchSelectItem };

export function searchRows(items: SearchSelectItem[], query: string): SearchSelectRow[] {
  const q = query.trim().toLowerCase();
  const matched = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  const rows: SearchSelectRow[] = [];

  for (const group of new Set(items.map((i) => i.group))) {
    const inGroup = matched.filter((i) => i.group === group);
    if (!inGroup.length) continue;
    if (group !== undefined) rows.push({ kind: "separator", label: group });
    for (const item of inGroup) rows.push({ kind: "item", item });
  }

  return rows;
}

/** Where a value sits in the rows, or -1 — what opens the list on the current choice. */
export function rowIndexOf(rows: SearchSelectRow[], value: string): number {
  return rows.findIndex((r) => r.kind === "item" && r.item.value === value);
}
