/**
 * The visible row order: the filter text applied first, then the sort.
 *
 * Directories always come before files regardless of the sort column, which is what every
 * desktop file manager does and what keyboard navigation assumes.
 */

import type { FsEntry } from "@/lib/fs-api";
import { extensionOf } from "./can-open-in-ppm";
import type { SortDir, SortKey } from "./explorer-store";

/** Locale-aware, digit-aware name compare so "file10" sorts after "file9". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareBy(key: SortKey, a: FsEntry, b: FsEntry): number {
  switch (key) {
    case "size":
      return (a.size ?? 0) - (b.size ?? 0);
    case "modified":
      return new Date(a.modified).getTime() - new Date(b.modified).getTime();
    case "kind": {
      const byExt = collator.compare(extensionOf(a.name), extensionOf(b.name));
      return byExt !== 0 ? byExt : collator.compare(a.name, b.name);
    }
    case "name":
      return collator.compare(a.name, b.name);
  }
}

export function sortAndFilterEntries(
  entries: FsEntry[],
  filter: string,
  sort: { key: SortKey; dir: SortDir },
): FsEntry[] {
  const needle = filter.trim().toLowerCase();
  const visible = needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
  const sign = sort.dir === "asc" ? 1 : -1;

  return [...visible].sort((a, b) => {
    const aDir = a.type === "directory";
    const bDir = b.type === "directory";
    if (aDir !== bDir) return aDir ? -1 : 1;
    const result = compareBy(sort.key, a, b);
    // Equal keys fall back to the name so the order never depends on readdir sequence.
    return (result !== 0 ? result : collator.compare(a.name, b.name)) * sign;
  });
}

/** Total bytes of the given entries; directories contribute nothing (size unknown). */
export function totalSize(entries: FsEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.type === "file" ? (e.size ?? 0) : 0), 0);
}
