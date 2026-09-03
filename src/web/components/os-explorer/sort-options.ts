/**
 * Shared sort vocabulary: the four sortable keys and the two directions, with the labels
 * shown to the user. The toolbar sort menu, the background context menu's "Sort by"
 * submenu, the List view's column headers and the mobile More sheet all read from here so
 * the four surfaces can never say something different about what "Kind" or "Descending"
 * means.
 */

import type { SortDir, SortKey } from "./explorer-store";

export const SORT_KEY_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "modified", label: "Modified" },
  { key: "kind", label: "Kind" },
];

export const SORT_DIR_OPTIONS: readonly { dir: SortDir; label: string }[] = [
  { dir: "asc", label: "Ascending" },
  { dir: "desc", label: "Descending" },
];

export function sortKeyLabel(key: SortKey): string {
  return SORT_KEY_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

export function sortDirLabel(dir: SortDir): string {
  return SORT_DIR_OPTIONS.find((option) => option.dir === dir)?.label ?? dir;
}
