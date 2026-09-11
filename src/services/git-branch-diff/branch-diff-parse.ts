/**
 * Parsing for a whole-branch diff: `git diff --numstat -z` for the line counts
 * and `git diff --raw -z` for the blob ids and change kinds, merged per path.
 *
 * Two commands rather than one because git concatenates the two formats when
 * both are asked for, and telling them apart afterwards is guesswork. They are
 * both cheap and run in parallel.
 *
 * `-z` throughout: without it a path containing a tab, a quote or a newline is
 * escaped and the record becomes ambiguous, and a rename is emitted as a single
 * `old => new` field that cannot be split reliably.
 *
 * (`packages/ext-git-graph/src/compare-args.ts` has its own numstat parser. It
 * stays separate on purpose: an extension is installed from npm into
 * `~/.ppm/extensions`, so it cannot import from `src/`.)
 */

import type { BranchDiffFile } from "../../types/git.ts";

type BranchDiffStatus = BranchDiffFile["status"];

interface RawEntry {
  status: BranchDiffStatus;
  blob: string;
  oldPath?: string;
}

/** One NUL-terminated record at a time, dropping the empty trailing field. */
function records(stdout: string): string[] {
  const parts = stdout.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * `git diff --numstat -z` → additions/deletions per path.
 *
 * A rename is three records: the counts with an empty path field, then the old
 * path, then the new one.
 */
export function parseNumstatZ(stdout: string): Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }> {
  const parts = records(stdout);
  const out = new Map<string, { additions: number; deletions: number; binary: boolean; oldPath?: string }>();

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
    const counts = {
      additions: binary ? 0 : Number(addedRaw) || 0,
      deletions: binary ? 0 : Number(deletedRaw) || 0,
      binary,
    };

    if (pathPart === "") {
      const oldPath = parts[++i] ?? "";
      const newPath = parts[++i] ?? "";
      out.set(newPath, { ...counts, oldPath });
      continue;
    }
    out.set(pathPart, counts);
  }

  return out;
}

/**
 * `git diff --raw -z --no-abbrev` → status and head-side blob id per path.
 *
 * Record shape: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>` then the path,
 * or two paths when the status is R or C. The status carries a similarity score
 * there (`R100`), which is dropped — the letter is the part anything acts on.
 *
 * `--no-abbrev` matters: the default abbreviates the ids to whatever length is
 * currently unambiguous in the repository, so the same file yields a different
 * string as the repository grows, and every stored review flag would clear.
 */
export function parseRawZ(stdout: string): Map<string, RawEntry> {
  const parts = records(stdout);
  const out = new Map<string, RawEntry>();

  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || !record.startsWith(":")) continue;
    const fields = record.slice(1).split(" ");
    if (fields.length < 5) continue;
    const blob = fields[3] ?? "";
    const letter = (fields[4] ?? "M").charAt(0).toUpperCase();
    const status = (["A", "M", "D", "R", "C", "T"].includes(letter) ? letter : "M") as BranchDiffStatus;

    if (status === "R" || status === "C") {
      const oldPath = parts[++i] ?? "";
      const newPath = parts[++i] ?? "";
      out.set(newPath, { status, blob, oldPath });
      continue;
    }
    const path = parts[++i] ?? "";
    if (path) out.set(path, { status, blob });
  }

  return out;
}

/**
 * Join the two, keyed by head-side path.
 *
 * The raw output is the spine rather than numstat's: it is the one that reports
 * a mode-only change (`T`), which numstat omits entirely, and a file missing
 * from it has no blob id to remember a review against.
 */
export function mergeBranchDiff(
  numstat: ReturnType<typeof parseNumstatZ>,
  raw: ReturnType<typeof parseRawZ>,
): BranchDiffFile[] {
  const files: BranchDiffFile[] = [];
  for (const [path, entry] of raw) {
    const counts = numstat.get(path);
    files.push({
      path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      additions: counts?.additions ?? 0,
      deletions: counts?.deletions ?? 0,
      binary: counts?.binary ?? false,
      blob: entry.blob,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Refs reach git as argv, so a shell is never involved — but an argument
 * starting with `-` is still read as an option, and `..` would turn one field
 * into a range and defeat the caller's choice of comparison.
 */
export function assertRef(value: string | undefined, label: string): string {
  const s = (value ?? "").trim();
  if (!s || s.startsWith("-") || s.includes("..") || /[\x00-\x1f\x7f~^:?*[\]\\]/.test(s)) {
    throw new Error(`Invalid git ref for ${label}: "${s}"`);
  }
  return s;
}
