/**
 * The shape `GET /api/projects/:name/git/blame` returns, and the formatting the
 * editor's inline annotation needs. Shared because the server produces it and
 * the frontend renders it.
 */

export interface BlameCommitInfo {
  hash: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  authorTime: number;
  summary: string;
  /** Path the file had at this commit — differs after a rename. */
  filename?: string;
  /** The commit this line came from before it, when git could work it out. */
  previous?: string;
}

export interface BlameLine {
  hash: string;
  /** 1-based line number in the file as it is now. */
  finalLine: number;
  /** 1-based line number in the file at that commit. */
  origLine: number;
}

export interface BlameResult {
  /** In final-line order, so `lines[n - 1]` is normally line n. */
  lines: BlameLine[];
  commits: Record<string, BlameCommitInfo>;
}

/** git uses an all-zero sha for lines that are not committed yet. */
export const UNCOMMITTED_HASH = "0".repeat(40);

export function isUncommittedHash(hash: string): boolean {
  return /^0+$/.test(hash);
}

/**
 * The one-line annotation shown after the cursor's line, in GitLens' shape:
 * "Author, 3 days ago • summary".
 *
 * `now` is a parameter rather than read from the clock so the wording can be
 * tested without freezing time.
 */
export function formatBlameAnnotation(
  commit: BlameCommitInfo | undefined | null,
  now: number = Date.now(),
): string {
  if (!commit) return "";
  if (isUncommittedHash(commit.hash)) return "You, uncommitted changes";
  const who = commit.author || "Unknown";
  const when = commit.authorTime > 0 ? formatRelativeTime(commit.authorTime * 1000, now) : "";
  const head = when ? `${who}, ${when}` : who;
  return commit.summary ? `${head} • ${commit.summary}` : head;
}

/** Coarse relative time. Anything past a year reads as a year count. */
export function formatRelativeTime(timestampMs: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestampMs) / 1000));
  if (seconds < 60) return "just now";

  const units: [limit: number, size: number, name: string][] = [
    [3600, 60, "minute"],
    [86400, 3600, "hour"],
    [2592000, 86400, "day"],
    [31536000, 2592000, "month"],
    [Infinity, 31536000, "year"],
  ];
  for (const [limit, size, name] of units) {
    if (seconds < limit) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
