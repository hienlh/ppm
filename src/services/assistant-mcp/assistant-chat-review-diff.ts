import { computeBlocks } from "../../shared/review-blocks.ts";
import type { SessionFileDiff } from "../../shared/session-file-changes.ts";
import type { TurnWithCalls } from "../session-file-baselines/session-turn-calls.ts";
import { MAX_REVIEW_DIFF_LINES } from "./assistant-chat-tool-definitions.ts";
import { clip } from "./assistant-tool-output.ts";

/**
 * One file's review as `chat_changes` answers it with a `path`: its blocks as the Review tab cuts
 * them (`src/shared/review-blocks.ts`, the same cut the server answers by key), each with the lines
 * it covers in the file now and the turns whose calls wrote it, and a unified diff of the blocks,
 * cut at a line budget. Pure.
 */

const MAX_LINE_CHARS = 400;

export interface ReviewedBlock {
  key: string;
  /** `12-18` in the file now; `12` for a block that only took lines out there. */
  lines: string;
  added: number;
  removed: number;
  kept?: boolean;
  /** Turns (by number) whose calls wrote it; `older` when a call is in a turn this cannot reach. */
  turns: number[];
  olderTurns?: boolean;
}

export interface FileReview {
  blocks: ReviewedBlock[];
  diff: string;
  /** Diff lines left out past the budget. */
  diffLinesCut?: number;
  note?: string;
}

export function fileReview(diff: SessionFileDiff, turns: readonly TurnWithCalls[]): FileReview {
  if (diff.binary || diff.tooLarge) return { blocks: [], diff: "", note: "Binary or too large to show; it can only be answered whole." };
  const cut = computeBlocks(diff.original, diff.modified, { timeoutMs: 1000 });
  if (!cut) return { blocks: [], diff: "", note: "Too slow to diff; it can only be answered whole." };
  const summaries = new Map((diff.blocks ?? []).map((b) => [b.key, b]));
  const turnOf = new Map<string, number>();
  for (const t of turns) if (!t.unnumbered) for (const call of t.calls) turnOf.set(call, t.n);

  const blocks: ReviewedBlock[] = cut.blocks.map((b) => {
    const summary = summaries.get(b.key);
    const calls = summary?.calls ?? [];
    const named = [...new Set(calls.map((c) => turnOf.get(c)).filter((n): n is number => n !== undefined))].sort((x, y) => x - y);
    const from = b.newFrom + 1;
    return {
      key: b.key,
      lines: b.newTo > b.newFrom ? `${from}-${b.newTo}` : `${from}`,
      added: b.added,
      removed: b.removed,
      ...(summary?.kept ? { kept: true } : {}),
      turns: named,
      ...(calls.some((c) => !turnOf.has(c)) ? { olderTurns: true } : {}),
    };
  });

  const lines: string[] = [];
  for (const b of cut.blocks) {
    lines.push(`@@ -${b.oldFrom + 1},${b.oldTo - b.oldFrom} +${b.newFrom + 1},${b.newTo - b.newFrom} @@ block ${b.key}`);
    for (const row of b.rows) lines.push(`${row.k}${clip(row.text, MAX_LINE_CHARS)}`);
  }
  const shown = lines.slice(0, MAX_REVIEW_DIFF_LINES);
  return {
    blocks,
    diff: shown.join("\n"),
    ...(lines.length > shown.length ? { diffLinesCut: lines.length - shown.length } : {}),
  };
}
