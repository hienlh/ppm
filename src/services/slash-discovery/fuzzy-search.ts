import type { SlashItem } from "./types.ts";

/** Iterative Levenshtein distance (single-row DP) */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,       // insertion
        prev[j]! + 1,            // deletion
        prev[j - 1]! + cost,     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

interface FuzzyScore { rank: number; distance: number }

/**
 * Score a query against a candidate string.
 * Returns null if no reasonable match. Rank: 0=prefix, 1=contains, 2=fuzzy.
 */
export function scoreFuzzy(query: string, candidate: string): FuzzyScore | null {
  const lq = query.toLowerCase();
  const lc = candidate.toLowerCase();

  if (lc.startsWith(lq)) return { rank: 0, distance: 0 };
  if (lc.includes(lq)) return { rank: 1, distance: lc.indexOf(lq) };

  const maxDist = Math.max(Math.floor(lq.length * 0.4), 2);
  const dist = levenshtein(lq, lc.slice(0, lq.length + maxDist));
  if (dist <= maxDist) return { rank: 2, distance: dist };

  return null;
}

/**
 * Search slash items by query with fuzzy matching.
 * Returns ranked results (best match first), truncated to limit.
 */
export function searchSlashItems(
  items: SlashItem[],
  query: string,
  limit = 20,
): SlashItem[] {
  if (!query) return items;
  // Cap query length to prevent quadratic blowup in Levenshtein
  query = query.slice(0, 50);

  const scored: Array<{ item: SlashItem; rank: number; distance: number }> = [];

  for (const item of items) {
    // Score against name and description, keep best
    const nameScore = scoreFuzzy(query, item.name);
    const descScore = scoreFuzzy(query, item.description);
    const best = [nameScore, descScore]
      .filter((s): s is FuzzyScore => s !== null)
      .sort((a, b) => a.rank - b.rank || a.distance - b.distance)[0];

    if (best) scored.push({ item, rank: best.rank, distance: best.distance });
  }

  scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.item.name.localeCompare(b.item.name));

  return scored.slice(0, limit).map((s) => s.item);
}
