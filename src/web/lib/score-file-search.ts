/**
 * File search scoring for command palette.
 * Lower score = better match. Returns null if no match.
 *
 * Tiers: exact filename(0) > filename prefix(1) > filename contains(2)
 *      > path contains(3) > fuzzy filename(4) > fuzzy path(5)
 *
 * Tie-breakers: shorter filename, fewer path segments.
 *
 * Hot-path note: callers pass PRE-LOWERCASED strings to avoid repeated
 * allocations per keystroke. Use `scoreFileSearch` (convenience wrapper)
 * for ad-hoc calls; use `scoreFileSearchFast` for the inner loop.
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
export function getFilename(path: string): string {
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

/**
 * Fast scoring — requires pre-lowercased inputs. Use for tight loops.
 * All string params MUST already be lowercase.
 */
export function scoreFileSearchFast(
  qLower: string,
  filenameLower: string,
  pathLower: string,
  labelLen: number,
  depth: number,
): FileSearchScore | null {
  // Multi-word query: score each word independently, require all to match
  if (qLower.includes(" ")) {
    const words = qLower.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    if (words.length === 1) {
      return scoreFileSearchFast(words[0]!, filenameLower, pathLower, labelLen, depth);
    }
    let maxTier = 0;
    let totalOffset = 0;
    for (const word of words) {
      const s = scoreFileSearchFast(word, filenameLower, pathLower, labelLen, depth);
      if (!s) return null;
      maxTier = Math.max(maxTier, s.tier);
      totalOffset += s.offset;
    }
    return { tier: maxTier, offset: totalOffset, nameLen: labelLen, depth };
  }

  // Tier 0: exact filename match
  if (filenameLower === qLower) return { tier: 0, offset: 0, nameLen: labelLen, depth };

  // Tier 1: filename starts with query
  if (filenameLower.startsWith(qLower)) return { tier: 1, offset: 0, nameLen: labelLen, depth };

  // Tier 2: filename contains query as substring
  const fnIdx = filenameLower.indexOf(qLower);
  if (fnIdx >= 0) return { tier: 2, offset: fnIdx, nameLen: labelLen, depth };

  // Tier 3: full path contains query as substring
  const pathIdx = pathLower.indexOf(qLower);
  if (pathIdx >= 0) return { tier: 3, offset: pathIdx, nameLen: labelLen, depth };

  // Tier 4: fuzzy match on filename
  const fnGap = fuzzyGap(qLower, filenameLower);
  if (fnGap >= 0) return { tier: 4, offset: fnGap, nameLen: labelLen, depth };

  // Tier 5: fuzzy match on full path
  const pathGap = fuzzyGap(qLower, pathLower);
  if (pathGap >= 0) return { tier: 5, offset: pathGap, nameLen: labelLen, depth };

  return null;
}

/** Convenience wrapper — lowers inputs on the fly. Use for ad-hoc calls. */
export function scoreFileSearch(
  query: string,
  label: string,
  path: string,
): FileSearchScore | null {
  const pathLower = path.toLowerCase();
  return scoreFileSearchFast(
    query.toLowerCase(),
    getFilename(pathLower),
    pathLower,
    label.length,
    path.split("/").length,
  );
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
