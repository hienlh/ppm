/**
 * Reading one `git show` into the pieces the editor's blame hover needs: the
 * commit's own fields, its full message, and the change it made to one line.
 *
 * One command carries all of it. `--format=%H%x00%an%x00...%B%x00` puts the
 * fields before the diff with NUL separators, which is the only separator that
 * cannot occur inside a commit message — and a commit message is exactly where
 * a chosen delimiter would eventually turn up.
 *
 * `--unified=0` is what makes the line lookup possible: with no context lines,
 * every line in a hunk body is a real change, so the hunk containing the blamed
 * line names that line's own edit rather than an edit up to three lines away.
 */

/**
 * The byte git writes for `%x00`, built rather than typed. A literal NUL in a
 * source file is invisible in every diff and makes the file read as binary to
 * grep; this has already cost this codebase an afternoon once.
 */
const NUL = String.fromCharCode(0);

export interface ShowFields {
  hash: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  authorTime: number;
  /** Subject and body, as committed, with trailing blank lines removed. */
  message: string;
  /** Everything after the message. Empty for a merge commit, which shows none. */
  diff: string;
}

export function parseShow(raw: string): ShowFields | null {
  // Five fields then the diff; a short split means the format did not run, which
  // is what a bad revision looks like when git still exits zero.
  const parts = raw.split(NUL);
  if (parts.length < 6) return null;
  const [hash, author, authorMail, authorTime, message] = parts;
  if (!hash?.trim()) return null;
  return {
    hash: hash.trim(),
    author: author ?? "",
    authorMail: authorMail ?? "",
    authorTime: Number(authorTime) || 0,
    message: (message ?? "").replace(/\s+$/, ""),
    diff: parts.slice(5).join(NUL).replace(/^\s*\n/, ""),
  };
}

export interface LineChange {
  /** What the commit removed at this line, oldest first. */
  removed: string[];
  /** The line as this commit wrote it. */
  added: string[];
}

interface Hunk {
  newStart: number;
  newCount: number;
  removed: string[];
  added: string[];
}

/**
 * `@@ -12,3 +14,2 @@` — and `@@ -14,0 +15 @@`, because git omits a count of one.
 * Reading a missing count as zero would make every single-line hunk unmatchable.
 */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // A new `diff --git` ends the previous file's hunks. Checked before the
    // `-`/`+` tests because `--- a/x` and `+++ b/x` follow it and would
    // otherwise be read as a removed and an added line.
    if (line.startsWith("diff --git")) current = null;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return hunks;
}

/**
 * The change this commit made at `newLine`, where `newLine` is the line number
 * in the file *as that commit left it* — which is what `git blame --porcelain`
 * reports as the original line, and not the line number in the file now.
 *
 * Null when the commit did not touch that line: a merge commit shows no diff at
 * all, and a line can also be attributed to a commit that only moved it.
 */
export function lineChangeAt(diff: string, newLine: number, maxRemoved = 3): LineChange | null {
  for (const hunk of parseHunks(diff)) {
    // `+n,0` means the commit deleted lines here and added none, so this hunk
    // contains no line of the new file at all.
    if (hunk.newCount === 0) continue;
    if (newLine < hunk.newStart || newLine >= hunk.newStart + hunk.newCount) continue;

    const offset = newLine - hunk.newStart;
    const line = hunk.added[offset];
    return {
      // Capped: a hunk that replaced two hundred lines would otherwise put all
      // of them into a hover.
      removed: hunk.removed.slice(0, maxRemoved),
      // The blamed line itself, not the whole hunk. Falls back to the hunk's
      // first added line if the header's count and the body ever disagree.
      added: line === undefined ? hunk.added.slice(0, 1) : [line],
    };
  }
  return null;
}
