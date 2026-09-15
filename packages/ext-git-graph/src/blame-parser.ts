/**
 * Parser for `git blame --porcelain`.
 *
 * The porcelain format emits the full commit header only the *first* time a
 * commit is seen; later lines from the same commit carry just the sha header,
 * an optional `previous`/`filename`, and the content line. So commit metadata
 * is accumulated into a map and lines reference it by sha — using
 * `--line-porcelain` instead would repeat every header and roughly triple the
 * output for no extra information.
 */

export interface BlameCommitInfo {
  hash: string;
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
  /** Set when this commit is the boundary of the traversal (e.g. a shallow root). */
  boundary: boolean;
  /** Path the file had at this commit — differs from the current path after a rename. */
  filename?: string;
}

export interface BlameLine {
  hash: string;
  /** 1-based line number in the file as it is now. */
  finalLine: number;
  /** 1-based line number in the file at that commit. */
  origLine: number;
  content: string;
}

export interface BlameResult {
  lines: BlameLine[];
  commits: Record<string, BlameCommitInfo>;
}

/** git uses an all-zero sha for lines that are not committed yet. */
export const UNCOMMITTED_HASH = "0".repeat(40);

export function isUncommittedHash(hash: string): boolean {
  return /^0+$/.test(hash);
}

function stripAngles(value: string): string {
  return value.replace(/^</, "").replace(/>$/, "");
}

export function parseBlamePorcelain(stdout: string): BlameResult {
  const commits: Record<string, BlameCommitInfo> = {};
  const lines: BlameLine[] = [];

  // Split on \n only: content lines may legitimately end with \r (a CRLF file),
  // and that \r belongs to the file, not to the porcelain framing.
  const rawLines = stdout.split("\n");
  let current: BlameCommitInfo | null = null;
  let finalLine = 0;
  let origLine = 0;

  for (const raw of rawLines) {
    if (raw === "") continue;

    // Content line — the only line kind that starts with a tab.
    if (raw.startsWith("\t")) {
      if (!current) continue;
      lines.push({ hash: current.hash, finalLine, origLine, content: raw.slice(1) });
      current = null;
      continue;
    }

    const header = raw.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/);
    if (header) {
      const hash = header[1] as string;
      origLine = Number(header[2]);
      finalLine = Number(header[3]);
      let info = commits[hash];
      if (!info) {
        info = {
          hash,
          author: isUncommittedHash(hash) ? "Not Committed Yet" : "",
          authorMail: "",
          authorTime: 0,
          summary: isUncommittedHash(hash) ? "Uncommitted changes" : "",
          boundary: false,
        };
        commits[hash] = info;
      }
      current = info;
      continue;
    }

    if (!current) continue;

    const sep = raw.indexOf(" ");
    const key = sep === -1 ? raw : raw.slice(0, sep);
    const value = sep === -1 ? "" : raw.slice(sep + 1);

    switch (key) {
      case "author":
        if (value) current.author = value;
        break;
      case "author-mail":
        current.authorMail = stripAngles(value);
        break;
      case "author-time":
        current.authorTime = Number(value) || 0;
        break;
      case "summary":
        if (value) current.summary = value;
        break;
      case "filename":
        current.filename = value;
        break;
      case "boundary":
        current.boundary = true;
        break;
      default:
        break;
    }
  }

  return { lines, commits };
}

/**
 * Map each commit to a 0..1 recency weight for the age heatmap: 1 = newest
 * commit in the blame, 0 = oldest. Uncommitted lines are excluded — they would
 * always peg the scale to "now" and flatten every real commit to 0.
 */
export function computeAgeWeights(commits: Record<string, BlameCommitInfo>): Record<string, number> {
  const times = Object.values(commits)
    .filter((c) => !isUncommittedHash(c.hash) && c.authorTime > 0)
    .map((c) => c.authorTime);
  const weights: Record<string, number> = {};
  if (times.length === 0) return weights;

  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = max - min;
  for (const c of Object.values(commits)) {
    if (isUncommittedHash(c.hash)) {
      weights[c.hash] = 1;
      continue;
    }
    weights[c.hash] = span === 0 ? 1 : (c.authorTime - min) / span;
  }
  return weights;
}
