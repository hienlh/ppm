/**
 * Range building and output parsing for the compare panel.
 *
 * The two refs are always validated separately and joined here. Accepting an
 * already-joined `a..b` string from the webview would defeat `assertValidRef`,
 * which rejects `..` precisely so that a single field cannot smuggle a range (or
 * an option) into a git argument.
 */
import { assertValidRef } from "./git-exec.ts";

export type CompareMode = "two-dot" | "three-dot";

/**
 * `a..b` lists commits reachable from b but not a.
 * `a...b` (for diff) compares b against the merge base — "what changed on b
 * since the branches diverged", which is what a review wants to see.
 */
export function buildRangeSpec(ref1: unknown, ref2: unknown, mode: CompareMode): string {
  const a = assertValidRef(ref1, "ref1");
  const b = assertValidRef(ref2, "ref2");
  return `${a}${mode === "three-dot" ? "..." : ".."}${b}`;
}

export interface CompareFileChange {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  /** true when git reported `-` for both counts, i.e. a binary file. */
  binary: boolean;
}

/**
 * Parse `git diff --numstat -z`.
 *
 * With `-z`, records are NUL-terminated and a rename is three records in a row:
 * the counts line, then the old path, then the new path. Without `-z` a path
 * containing a tab or a quote would be escaped and ambiguous.
 */
export function parseNumstatZ(stdout: string): CompareFileChange[] {
  const parts = stdout.split("\0");
  const changes: CompareFileChange[] = [];

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const tab1 = record.indexOf("\t");
    if (tab1 === -1) continue;
    const tab2 = record.indexOf("\t", tab1 + 1);
    if (tab2 === -1) continue;

    const addedRaw = record.slice(0, tab1);
    const deletedRaw = record.slice(tab1 + 1, tab2);
    const pathPart = record.slice(tab2 + 1);
    const binary = addedRaw === "-" && deletedRaw === "-";

    if (pathPart === "") {
      // Rename/copy: the two paths follow as separate NUL-terminated records.
      const oldPath = parts[++i] ?? "";
      const newPath = parts[++i] ?? "";
      changes.push({
        path: newPath,
        oldPath,
        additions: binary ? 0 : Number(addedRaw) || 0,
        deletions: binary ? 0 : Number(deletedRaw) || 0,
        binary,
      });
      continue;
    }

    changes.push({
      path: pathPart,
      additions: binary ? 0 : Number(addedRaw) || 0,
      deletions: binary ? 0 : Number(deletedRaw) || 0,
      binary,
    });
  }

  return changes;
}

/** Parse `git rev-list --left-right --count a...b` → "3\t7". */
export function parseAheadBehind(stdout: string): { behind: number; ahead: number } {
  const [left, right] = stdout.trim().split(/\s+/);
  return { behind: Number(left) || 0, ahead: Number(right) || 0 };
}

export interface RefEntry {
  name: string;
  hash: string;
  kind: "head" | "remote" | "tag";
}

/** Parse `git for-each-ref --format=%(refname)%1f%(objectname)%1f%(refname:short)`. */
export function parseRefList(stdout: string): RefEntry[] {
  const refs: RefEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [fullName, hash, shortName] = line.split("\x1f");
    if (!fullName || !hash || !shortName) continue;
    const kind = fullName.startsWith("refs/tags/")
      ? "tag"
      : fullName.startsWith("refs/remotes/")
        ? "remote"
        : "head";
    refs.push({ name: shortName, hash, kind });
  }
  return refs;
}
