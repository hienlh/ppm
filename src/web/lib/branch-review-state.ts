/**
 * Which files of a branch review have already been looked at.
 *
 * Stored per device in `localStorage` and never on the server: this is "where
 * had I got to", which belongs to the screen the reading happened on, not to
 * the project. A phone that opened the same branch has its own progress.
 *
 * The value stored per path is the file's **head-side blob id**, not `true`.
 * A branch under review keeps growing, and the two obvious alternatives both
 * fail: keying the whole record by the head commit throws the entire progress
 * away on every new commit, while a plain boolean keeps a file ticked after it
 * has been rewritten — silently marking unreviewed code as reviewed, which is
 * the worse of the two. Comparing blob ids clears exactly the files that
 * actually changed and leaves the rest alone.
 *
 * The storage calls are the only impure part, and they are at the edges:
 * everything that decides anything is a pure function, so it is testable
 * without a DOM (importing a zustand store instead would read `localStorage` at
 * module scope and throw under `bun:test`).
 */
import type { BranchDiffFile } from "../../types/git";

const PREFIX = "ppm:branch-review";

/** Where the list of comparisons that have progress stored is kept. */
const RECENT_KEY = `${PREFIX}:recent`;

/**
 * How many comparisons keep their progress.
 *
 * One `localStorage` key per ref pair ever compared, and `pruneReviewed` only
 * prunes *within* a key — so comparing twenty branches against main left twenty
 * records, none of which anything would ever delete. Twenty is well past what a
 * person has open reviews of, and the cost of falling off the end is a list of
 * ticks, not work.
 */
const MAX_REMEMBERED = 20;

/** path → blob id the file had when it was marked reviewed. */
export type ReviewState = Record<string, string>;

/**
 * Keyed by ref *names*, so progress survives new commits on either side —
 * whether a given file is still reviewed is then decided by its blob id.
 */
export function reviewKey(projectName: string, base: string, head: string): string {
  return `${PREFIX}:${projectName}:${base}:${head}`;
}

export function isReviewed(state: ReviewState, file: BranchDiffFile): boolean {
  return state[file.path] === file.blob;
}

export function toggleReviewed(state: ReviewState, file: BranchDiffFile): ReviewState {
  const next = { ...state };
  if (isReviewed(state, file)) delete next[file.path];
  else next[file.path] = file.blob;
  return next;
}

export function setAllReviewed(state: ReviewState, files: BranchDiffFile[], reviewed: boolean): ReviewState {
  if (!reviewed) return {};
  const next = { ...state };
  for (const file of files) next[file.path] = file.blob;
  return next;
}

export function reviewedCount(state: ReviewState, files: BranchDiffFile[]): number {
  return files.reduce((n, file) => n + (isReviewed(state, file) ? 1 : 0), 0);
}

/**
 * Drop entries for files the diff no longer contains.
 *
 * Without this the record only ever grows: every path ever touched on a
 * long-lived branch stays in `localStorage` after the commit that touched it is
 * amended or rebased away.
 */
export function pruneReviewed(state: ReviewState, files: BranchDiffFile[]): ReviewState {
  const live = new Set(files.map((f) => f.path));
  const next: ReviewState = {};
  for (const [path, blob] of Object.entries(state)) {
    if (live.has(path)) next[path] = blob;
  }
  return next;
}

/**
 * The file a review should open on.
 *
 * Not simply the first: the list is sorted by path, so a repository whose first
 * changed file is an image opens on a binary placeholder where the code should
 * be. Falls back to the first entry when every changed file is binary.
 */
export function firstReviewable(files: BranchDiffFile[]): BranchDiffFile | null {
  return files.find((f) => !f.binary) ?? files[0] ?? null;
}

/** The next file still needing review, wrapping around from `fromPath`. */
export function nextUnreviewed(
  state: ReviewState,
  files: BranchDiffFile[],
  fromPath: string | null,
): BranchDiffFile | null {
  if (files.length === 0) return null;
  const start = fromPath ? files.findIndex((f) => f.path === fromPath) + 1 : 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[(start + i) % files.length];
    if (file && !isReviewed(state, file)) return file;
  }
  return null;
}

export function loadReviewed(key: string): ReviewState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Anything could be under this key — it is a device-local string the user
    // can edit. Only string values survive, so a tampered entry cannot make
    // `isReviewed` compare against a non-string and throw during render.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: ReviewState = {};
    for (const [path, blob] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof blob === "string") state[path] = blob;
    }
    return state;
  } catch {
    return {};
  }
}

/**
 * `recent` with `key` moved to the front, capped at `max`.
 *
 * Returns the surviving order and the keys that fell off, so the caller can
 * delete exactly those — pure, because deciding what to evict is the part worth
 * testing and `localStorage` is not available under `bun:test`.
 */
export function nextRecent(
  recent: readonly string[],
  key: string,
  max = MAX_REMEMBERED,
): { recent: string[]; evicted: string[] } {
  const moved = [key, ...recent.filter((k) => k !== key)];
  return { recent: moved.slice(0, max), evicted: moved.slice(max) };
}

/** The stored order, with anything that is not a string dropped. */
function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function saveReviewed(key: string, state: ReviewState): void {
  try {
    if (Object.keys(state).length === 0) {
      localStorage.removeItem(key);
      const kept = readRecent().filter((k) => k !== key);
      localStorage.setItem(RECENT_KEY, JSON.stringify(kept));
      return;
    }
    localStorage.setItem(key, JSON.stringify(state));
    const { recent, evicted } = nextRecent(readRecent(), key);
    for (const stale of evicted) localStorage.removeItem(stale);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Private browsing, or the quota is full. Losing review progress is not
    // worth failing the render over.
  }
}
