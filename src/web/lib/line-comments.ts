/**
 * Comments a person leaves on single lines — of a chat's changes in the Review tab, or of a plan
 * waiting for approval — and the one message they become. The AI reads each comment beside the
 * line it is about, quoted, so it never has to guess which line "this" meant.
 */

/** A comment on one line of a file a chat changed. */
export interface ReviewLineComment {
  id: string;
  path: string;
  /** The line's number in the file now, or in the base for a removed line. */
  line: number;
  /** `old` for a removed line: its number is the base's. */
  side: "new" | "old";
  /** The line as it reads, so the comment still makes sense after the file moves on. */
  quote: string;
  body: string;
}

/** Most characters of a line quoted beside its comment. */
const MAX_QUOTE = 300;

function quoteOf(text: string): string {
  const t = text.trim();
  return t.length > MAX_QUOTE ? t.slice(0, MAX_QUOTE - 1) + "…" : t;
}

/** Text that cannot close the code span it is put in. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + pad + text + pad + fence;
}

/** Every comment with a body, as one message: grouped by file, in line order. */
export function formatReviewComments(comments: readonly ReviewLineComment[]): string {
  const live = comments.filter((c) => c.body.trim());
  if (live.length === 0) return "";
  const byFile = new Map<string, ReviewLineComment[]>();
  for (const c of live) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts = ["Review comments on the changes in this chat — please address each one:"];
  for (const [path, list] of byFile) {
    parts.push("**" + path + "**");
    for (const c of [...list].sort((a, b) => a.line - b.line)) {
      const where = c.side === "old" ? "removed line " + c.line : "line " + c.line;
      const quote = quoteOf(c.quote);
      parts.push("- " + where + (quote ? " " + inlineCode(quote) : "") + "\n  " + c.body.trim().replace(/\n/g, "\n  "));
    }
  }
  return parts.join("\n\n");
}

/** A comment on one line of a plan, by its 0-based index in the plan's lines. */
export type PlanComments = Record<number, string>;

/**
 * What the AI is told when the plan is sent back with comments: each commented line quoted with
 * its number, the comment under it, then whatever the person added overall.
 */
export function formatPlanComments(planLines: readonly string[], comments: PlanComments, overall = ""): string {
  const entries = Object.entries(comments)
    .map(([i, body]) => [Number(i), body.trim()] as const)
    .filter(([i, body]) => body && i >= 0 && i < planLines.length)
    .sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  if (entries.length) {
    parts.push("Comments on the plan — revise it to address each one, then present it again:");
    for (const [i, body] of entries) {
      parts.push("> " + (i + 1) + ": " + quoteOf(planLines[i]!) + "\n\n" + body);
    }
  }
  if (overall.trim()) parts.push(entries.length ? "Also: " + overall.trim() : overall.trim());
  return parts.join("\n\n");
}
