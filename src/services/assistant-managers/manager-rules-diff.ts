/**
 * How a change to a project's `.ppm/manager.md` is judged before anything else looks at it. Pure.
 *
 * "Only additions" is not the same as "only tightening": a comment opened above an old rule, a
 * heading moved over it or an "Exception: …" line are all pure additions that loosen. So the diff
 * is ordered (a moved line counts as removed and added), and only plain inserted lines — no
 * Markdown structure, no hidden characters, none of the words that carve out exceptions — may go
 * on to the one-shot check. Everything else waits for the user.
 */

export type RulesHoldReason = "removed" | "structural" | "keyword" | "too_complex";

export type RulesChange =
  | { kind: "same" }
  /** Held for the user; `lines` are the lines that made it so (removed or added). */
  | { kind: "hold"; reason: RulesHoldReason; lines: string[] }
  /** Only plain lines were inserted; each still needs the check to call it a restriction. */
  | { kind: "additions"; lines: string[] };

export type RulesDiffOp = { op: "same" | "add" | "remove"; line: string };

/** Above this many cells the ordered diff is not attempted and the change is held. */
const MAX_DIFF_CELLS = 2_000_000;

/** Words that carve out an exception or switch a rule off, matched anywhere in an added line. */
export const RELAXING_WORDS = [
  "ignore", "override", "exception", "no longer", "does not need", "doesn't need", "instead of", "unless", "except",
] as const;

const HIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const STRUCTURAL: readonly RegExp[] = [
  /^#{1,6}(\s|$)/, // heading
  /^(`{3,}|~{3,})/, // fence
  /<!--|-->/, // comment
  /^>/, // quote marker
  /<\/?[a-z][\w-]*(\s[^<>]*)?\/?>|<[!?]/i, // HTML tag, doctype or processing instruction
  /^(=+|-+|(\*\s*){3,}|(_\s*){3,})$/, // setext underline (turns the line above into a heading) or a rule
  /^\[[^\]]+\]:\s*\S/, // link reference definition: renders as nothing
];

/** A line as compared: curly apostrophes straightened, runs of whitespace folded, ends trimmed. */
export function normalizeRulesLine(line: string): string {
  return line.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/** The non-blank lines of `text`, as written. */
function ruleLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => normalizeRulesLine(line) !== "");
}

/**
 * The ordered line diff from `before` to `after` (longest common subsequence), blank lines and
 * whitespace-only differences ignored. Null when the files are too large to diff here.
 */
export function diffRuleLines(before: string, after: string): RulesDiffOp[] | null {
  const a = ruleLines(before);
  const b = ruleLines(after);
  const ka = a.map(normalizeRulesLine);
  const kb = b.map(normalizeRulesLine);
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  // lcs[i][j]: common subsequence length of a[start+i..endA) and b[start+j..endB).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = ka[start + i] === kb[start + j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: RulesDiffOp[] = a.slice(0, start).map((line) => ({ op: "same", line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[start + i] === kb[start + j]) { ops.push({ op: "same", line: b[start + j]! }); i++; j++; }
    else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) { ops.push({ op: "add", line: b[start + j]! }); j++; }
    else { ops.push({ op: "remove", line: a[start + i]! }); i++; }
  }
  for (const line of b.slice(endB)) ops.push({ op: "same", line });
  return ops;
}

/** Why an added line may not be judged by the check, or null for a plain line. */
export function addedLineHoldReason(line: string): "structural" | "keyword" | null {
  if (HIDDEN_CHARS.test(line)) return "structural";
  const text = normalizeRulesLine(line);
  if (STRUCTURAL.some((re) => re.test(text))) return "structural";
  const lower = text.toLowerCase();
  if (RELAXING_WORDS.some((word) => lower.includes(word))) return "keyword";
  return null;
}

/** What a change from the accepted rules to the file amounts to. */
export function classifyRulesChange(accepted: string, file: string): RulesChange {
  const ops = diffRuleLines(accepted, file);
  if (!ops) return { kind: "hold", reason: "too_complex", lines: [] };
  const removed = ops.filter((o) => o.op === "remove").map((o) => o.line);
  const added = ops.filter((o) => o.op === "add").map((o) => o.line);
  if (removed.length > 0) return { kind: "hold", reason: "removed", lines: removed };
  if (added.length === 0) return { kind: "same" };
  for (const reason of ["structural", "keyword"] as const) {
    const lines = added.filter((line) => addedLineHoldReason(line) === reason);
    if (lines.length > 0) return { kind: "hold", reason, lines };
  }
  return { kind: "additions", lines: added };
}

/** The lines `next` has that `base` does not, in order (the ordered diff's insertions). */
export function linesAddedSince(base: string, next: string): string[] {
  return (diffRuleLines(base, next) ?? []).filter((o) => o.op === "add").map((o) => o.line);
}

/** The lines `next` dropped from `base`, in order. */
export function linesRemovedSince(base: string, next: string): string[] {
  return (diffRuleLines(base, next) ?? []).filter((o) => o.op === "remove").map((o) => o.line);
}
