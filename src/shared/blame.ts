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

/**
 * What the editor's blame hover shows beyond the one-line annotation: the whole
 * commit message, and the change the commit made to the hovered line.
 *
 * Separate from `BlameCommitInfo` because it costs a `git show` per commit,
 * where the annotation costs one `git blame` per file. It is fetched for the
 * line the cursor is on and nothing else.
 */
export interface BlameLineDetail {
  hash: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  authorTime: number;
  /** Subject and body, as committed. */
  message: string;
  /** What the commit removed at this line, capped. */
  removed: string[];
  /** The line as this commit wrote it. */
  added: string[];
}

/**
 * The absolute date beside the relative one, in GitLens' wording:
 * "December 2nd, 2025 4:17 PM". Both are shown because "9 months ago" is the
 * useful reading and the exact date is the one you need to go looking for a
 * commit.
 *
 * Built by hand rather than with `toLocaleString`, whose output depends on the
 * host's locale and would make the format untestable and inconsistent between
 * the machine serving PPM and the phone reading it.
 */
export function formatAbsoluteTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const day = d.getDate();
  const hour12 = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, "0");
  const meridiem = d.getHours() < 12 ? "AM" : "PM";
  return `${months[d.getMonth()]} ${day}${ordinalSuffix(day)}, ${d.getFullYear()} ${hour12}:${minute} ${meridiem}`;
}

function ordinalSuffix(day: number): string {
  // 11th, 12th, 13th are the exceptions to the last-digit rule.
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
