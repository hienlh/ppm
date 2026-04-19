/**
 * File search scoring for command palette.
 * Lower score = better match. Returns null if no match.
 *
 * Tiers: exact filename(0) > filename prefix(1) > filename contains(2)
 *      > path contains(3) > fuzzy filename(4) > fuzzy path(5)
 *
 * Tie-breakers: shorter filename, fewer path segments.
 */

export interface FileSearchScore {
  /** 0-5, lower = better tier */
  tier: number;
  /** Position of substring match, or fuzzy gap penalty */
  offset: number;
  /** Candidate filename length (shorter = better) */
  nameLen: number;
  /** Number of path segments (fewer = more prominent) */
  depth: number;
}

/** Extract filename from a path */
function getFilename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Subsequence fuzzy match — returns gap penalty (sum of distances between
 * consecutive matched chars). Lower = more consecutive. Returns -1 if no match.
 */
function fuzzyGap(query: string, text: string): number {
  let ti = 0;
  let gap = 0;
  let lastMatch = -1;
  for (let qi = 0; qi < query.length; qi++) {
    ti = text.indexOf(query[qi]!, ti);
    if (ti === -1) return -1;
    if (lastMatch >= 0) gap += ti - lastMatch - 1;
    lastMatch = ti;
    ti++;
  }
  return gap;
}

export function scoreFileSearch(
  query: string,
  label: string,
  path: string,
): FileSearchScore | null {
  const q = query.toLowerCase();
  const nameLower = label.toLowerCase();
  const pathLower = path.toLowerCase();
  const filename = getFilename(pathLower);
  const depth = path.split("/").length;

  // Tier 0: exact filename match
  if (filename === q) return { tier: 0, offset: 0, nameLen: label.length, depth };

  // Tier 1: filename starts with query
  if (filename.startsWith(q)) return { tier: 1, offset: 0, nameLen: label.length, depth };

  // Tier 2: filename contains query as substring
  const fnIdx = filename.indexOf(q);
  if (fnIdx >= 0) return { tier: 2, offset: fnIdx, nameLen: label.length, depth };

  // Tier 3: full path contains query as substring
  const pathIdx = pathLower.indexOf(q);
  if (pathIdx >= 0) return { tier: 3, offset: pathIdx, nameLen: label.length, depth };

  // Tier 4: fuzzy match on filename
  const fnGap = fuzzyGap(q, filename);
  if (fnGap >= 0) return { tier: 4, offset: fnGap, nameLen: label.length, depth };

  // Tier 5: fuzzy match on full path
  const pathGap = fuzzyGap(q, pathLower);
  if (pathGap >= 0) return { tier: 5, offset: pathGap, nameLen: label.length, depth };

  return null;
}

/** Compare two scores — for Array.sort (ascending = best first) */
export function compareScores(a: FileSearchScore, b: FileSearchScore): number {
  return (
    a.tier - b.tier ||
    a.offset - b.offset ||
    a.nameLen - b.nameLen ||
    a.depth - b.depth
  );
}
