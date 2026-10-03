/**
 * The pure half of the session review's list: totals, display paths and review marks. No I/O
 * and no stores, so it runs under `bun:test`.
 */
import type { SessionFileChange } from "../../shared/session-file-changes";

/** Lines added and removed across the session; a file that could not be counted adds nothing. */
export function sessionChangeTotals(files: SessionFileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.additions ?? 0;
    removed += f.deletions ?? 0;
  }
  return { added, removed };
}

/**
 * The path as the list shows it: relative to the project when the file is inside it,
 * absolute otherwise — a session can write anywhere its tools can reach.
 */
export function displayPath(path: string, projectPath: string | undefined): string {
  if (!projectPath) return path;
  const root = projectPath.replace(/[\\/]+$/, "");
  if (path.length > root.length && path.startsWith(root) && /[\\/]/.test(path[root.length]!)) {
    return path.slice(root.length + 1);
  }
  return path;
}

/** Splits at the last separator, either kind: the host may be Windows. */
export function splitDisplayPath(path: string): { base: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i) };
}

export function fileCount(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

/** The files left to review, and those marked reviewed as they are now, which the lists hide. */
export function splitReviewed(files: SessionFileChange[]): { pending: SessionFileChange[]; reviewed: SessionFileChange[] } {
  const pending: SessionFileChange[] = [];
  const reviewed: SessionFileChange[] = [];
  for (const f of files) (f.reviewed ? reviewed : pending).push(f);
  return { pending, reviewed };
}

/**
 * `files` with `paths` marked or unmarked reviewed, ahead of the server's answer, so a click
 * hides or brings back the row at once. The line counts catch up with the next list.
 */
export function withReviewed(files: SessionFileChange[], paths: ReadonlySet<string>, reviewed: boolean): SessionFileChange[] {
  return files.map((f) => {
    if (!paths.has(f.path)) return f;
    const { reviewed: _wasReviewed, sinceReview: _wasSince, ...rest } = f;
    return reviewed ? { ...rest, reviewed: true } : rest;
  });
}

/**
 * Changes whenever what a diff of this file would show does: every write moves the version,
 * the baseline kind moves when a fallback to git HEAD turns into the session's own copy, and
 * a mark moves what a file changed since it was reviewed is diffed against.
 */
export function changeKey(file: SessionFileChange): string {
  const review = file.reviewed ? "reviewed" : file.sinceReview ? "since" : "";
  return `${file.path}\0${file.status}\0${file.baseline}\0${file.version}\0${review}`;
}
