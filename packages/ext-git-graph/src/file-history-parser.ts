/**
 * Parser for the combined `git log --follow --name-status` output used by the
 * file history panel.
 *
 * One git invocation carries both the commit metadata and the per-commit file
 * status. Records are separated by \x1e and metadata fields by \x1f — control
 * characters rather than `|` or tabs, because a commit subject may legitimately
 * contain either, and a rename record already uses tabs as its own separator.
 */

export const RECORD_SEP = "\x1e";
export const FIELD_SEP = "\x1f";

/** `--format` value that produces the records this module parses. */
export const FILE_HISTORY_FORMAT =
  `${RECORD_SEP}%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%s`;

export interface FileHistoryEntry {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  /** Status of the tracked file at this commit: A/M/D/R/C. */
  status: string;
  /** Path the file had at this commit — after a rename this is the new path. */
  path: string;
  /** Previous path, present only on a rename or copy. */
  oldPath?: string;
}

export function parseFileHistory(stdout: string): FileHistoryEntry[] {
  const entries: FileHistoryEntry[] = [];

  for (const record of stdout.split(RECORD_SEP)) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const fields = (lines[0] ?? "").split(FIELD_SEP);
    if (fields.length < 6) continue;

    const parents = fields[1] ?? "";
    const entry: FileHistoryEntry = {
      hash: fields[0] ?? "",
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author: fields[2] ?? "",
      authorEmail: fields[3] ?? "",
      authorDate: Number(fields[4]) || 0,
      subject: fields[5] ?? "",
      status: "M",
      path: "",
    };

    // First name-status line wins: with --follow git reports the one tracked
    // path per commit, and a merge commit may report none at all.
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0];
      const first = parts[1];
      if (!code || !first) continue;
      const letter = code[0] ?? "M";
      entry.status = letter;
      const second = parts[2];
      if ((letter === "R" || letter === "C") && second) {
        entry.oldPath = first;
        entry.path = second;
      } else {
        entry.path = first;
      }
      break;
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Build the `-L<start>,<end>:<file>` argument for line history.
 * Callers must have validated the numbers and the path already; this only fixes
 * the ordering so an inverted selection still produces a valid range.
 */
export function buildLineRangeArg(start: number, end: number, filePath: string): string {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  return `-L${lo},${hi}:${filePath}`;
}
