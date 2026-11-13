/**
 * Matching for the command palette's path mode, where the query is an absolute path
 * (`D:\dir\file.mp4`, `~/dir/fi`) and the list holds the entries of that directory.
 *
 * Kept apart from the palette so it can be tested without the stores it pulls in.
 */

/**
 * The part of a path query after its last separator — what the user is typing inside the
 * directory. Both separators count: a Windows path has no `/` at all, and splitting on
 * `/` alone left the filter empty, so every entry of the folder was listed unranked.
 */
export function pathQueryFileFilter(query: string): string {
  const lastSep = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  return query.slice(lastSep + 1).toLowerCase();
}

/** 0 = the name itself, 1 = starts with it, 2 = contains it, null = no match. */
function matchTier(nameLower: string, filter: string): number | null {
  if (nameLower === filter) return 0;
  if (nameLower.startsWith(filter)) return 1;
  if (nameLower.includes(filter)) return 2;
  return null;
}

/**
 * Entries whose name contains `filter`, closest first: the exact name, then names starting
 * with it, then the rest; within a tier the shorter name wins, since it is nearer to what
 * was typed. Matching is on the name only — every entry shares the directory, so matching
 * the full path would let the directory's own name match everything.
 */
export function rankPathQueryMatches<T>(items: T[], filter: string, nameOf: (item: T) => string): T[] {
  if (!filter) return items;
  const ranked: Array<{ item: T; tier: number; len: number }> = [];
  for (const item of items) {
    const name = nameOf(item).toLowerCase();
    const tier = matchTier(name, filter);
    if (tier !== null) ranked.push({ item, tier, len: name.length });
  }
  ranked.sort((a, b) => a.tier - b.tier || a.len - b.len);
  return ranked.map((r) => r.item);
}
