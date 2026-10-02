/**
 * Searching a project's file list where it is held — on the index worker — for a list too long
 * to send to the browser (`REMOTE_FILE_SEARCH_FROM_ENTRIES`). It ranks exactly as the palette
 * ranks a list it holds itself (`score-file-search.ts`), so a project does not start searching
 * differently for crossing the threshold.
 *
 * Two things make a keystroke cheaper here than the palette's own loop over the same list. Only
 * the best `limit` are ordered (`BestOf`). And a query that extends a recent one only looks at
 * what that one matched: every tier is a match of the query as a subsequence of the path, which
 * each prefix of the query matches too.
 */
import type { FileEntry } from "../../types/project.ts";
import { compareScores, getFilename, scoreFileSearchFast, scoreWordsFast, type FileSearchScore } from "../../web/lib/score-file-search.ts";

/** Files only (the palette, the compare picker), or directories too (the chat's @-picker). */
export type SearchKind = "file" | "all";

/** A list prepared for searching: every path lowercased once, instead of once per keystroke. */
export interface SearchableIndex {
  entries: FileEntry[];
  pathLower: string[];
  nameLower: string[];
  depth: Uint16Array;
  /** The last few queries and what each matched, the most recent last. */
  recent: { kind: SearchKind; query: string; matches: Int32Array }[];
}

const RECENT_QUERIES = 8;

export function toSearchable(entries: FileEntry[]): SearchableIndex {
  const n = entries.length;
  const pathLower = new Array<string>(n);
  const nameLower = new Array<string>(n);
  const depth = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const path = entries[i]!.path;
    const lower = path.toLowerCase();
    pathLower[i] = lower;
    nameLower[i] = getFilename(lower);
    let segments = 1;
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) segments++;
    depth[i] = segments;
  }
  return { entries, pathLower, nameLower, depth, recent: [] };
}

/**
 * The best `limit` entries of `kind` for `query`, best first — the order the palette would put
 * them in. A blank query answers the first `limit` in list order, which is what a picker shows
 * before anything is typed.
 */
export function searchIndex(index: SearchableIndex, query: string, kind: SearchKind, limit: number): FileEntry[] {
  const { entries } = index;
  if (!query.trim()) {
    if (kind === "all") return entries.slice(0, limit);
    const first: FileEntry[] = [];
    for (let i = 0; i < entries.length && first.length < limit; i++) {
      if (entries[i]!.type === "file") first.push(entries[i]!);
    }
    return first;
  }

  // As the palette reads it: `./` and `../` name the project root, which the paths leave out.
  const q = query.toLowerCase().replace(/^\.\.?\//, "");
  const words = q.includes(" ") ? q.split(/\s+/).filter(Boolean) : null;
  const narrowed = narrowFrom(index, kind, q);
  const best = new BestOf(limit);
  const matches = new Int32Array(narrowed ? narrowed.length : entries.length);
  let matched = 0;
  const visit = (i: number) => {
    const score = words
      ? scoreWordsFast(words, index.nameLower[i]!, index.pathLower[i]!, entries[i]!.name.length, index.depth[i]!)
      : scoreFileSearchFast(q, index.nameLower[i]!, index.pathLower[i]!, entries[i]!.name.length, index.depth[i]!);
    if (!score) return;
    best.offer(i, score);
    matches[matched++] = i;
  };
  if (narrowed) {
    for (let k = 0; k < narrowed.length; k++) visit(narrowed[k]!);
  } else {
    for (let i = 0; i < entries.length; i++) {
      if (kind === "all" || entries[i]!.type === "file") visit(i);
    }
  }
  remember(index, { kind, query: q, matches: matches.slice(0, matched) });
  return best.sorted().map((i) => entries[i]!);
}

interface Ranked { i: number; score: FileSearchScore }

/** The palette's order, which is a stable sort: equal scores stay in list order. */
function rank(a: Ranked, b: Ranked): number {
  return compareScores(a.score, b.score) || a.i - b.i;
}

/**
 * The best `limit` of what it is offered, kept in a heap with the worst on top — so each match
 * costs at most a comparison with it. Sorting every match instead was 25 ms of the 46 that a
 * one-letter query took on nxsys-workspace, most of it spent ordering what nobody would see.
 */
class BestOf {
  private readonly heap: Ranked[] = [];
  constructor(private readonly limit: number) {}

  offer(i: number, score: FileSearchScore): void {
    const { heap } = this;
    if (heap.length < this.limit) {
      heap.push({ i, score });
      let at = heap.length - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (rank(heap[at]!, heap[parent]!) <= 0) break;
        [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
        at = parent;
      }
      return;
    }
    if (this.limit === 0 || rank({ i, score }, heap[0]!) >= 0) return;
    heap[0] = { i, score };
    let at = 0;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let worst = at;
      if (left < heap.length && rank(heap[left]!, heap[worst]!) > 0) worst = left;
      if (right < heap.length && rank(heap[right]!, heap[worst]!) > 0) worst = right;
      if (worst === at) break;
      [heap[at], heap[worst]] = [heap[worst]!, heap[at]!];
      at = worst;
    }
  }

  sorted(): number[] {
    return [...this.heap].sort(rank).map((r) => r.i);
  }
}

/** What the longest recent query that `q` extends matched: all `q` can match is among it. */
function narrowFrom(index: SearchableIndex, kind: SearchKind, q: string): Int32Array | null {
  let from: SearchableIndex["recent"][number] | null = null;
  for (const recent of index.recent) {
    if (recent.kind !== kind || !recent.query || !q.startsWith(recent.query)) continue;
    if (!from || recent.query.length > from.query.length) from = recent;
  }
  return from?.matches ?? null;
}

function remember(index: SearchableIndex, search: SearchableIndex["recent"][number]): void {
  const recent = index.recent.filter((r) => r.kind !== search.kind || r.query !== search.query);
  recent.push(search);
  index.recent = recent.slice(-RECENT_QUERIES);
}
