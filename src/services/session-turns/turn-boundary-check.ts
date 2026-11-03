/**
 * Whether a transcript line is still what the turn index saw begin there.
 *
 * The index remembers byte offsets, and a transcript is not always append-only: stripping images
 * rewrites it in place, under the same inode, and every later record moves. Before a reader trusts
 * a range it checks the line at each end against what the index recorded there (`TurnBoundary`).
 * The check has to recognise *that* record, not merely a record of the same kind, or a shifted
 * file could pass it with another turn's text.
 */
import { isRealPromptRecord, promptFirstLine, promptTextOf } from "../../shared/user-prompt-kind.ts";
import { claudePromptLabel } from "./turn-index-claude.ts";
import { isAnswer, userText } from "./turn-index-codex.ts";
import type { TurnBoundary } from "./session-turn-types.ts";

type Rec = Record<string, unknown>;

function parse(text: string): Rec | null {
  try {
    const rec = JSON.parse(text) as unknown;
    return rec && typeof rec === "object" ? rec as Rec : null;
  } catch {
    return null;
  }
}

/**
 * Claude: the prompt record that opened the turn — by its `promptId` (its uuid for `u:` ids), and
 * by its label, since the CLI can reuse a `promptId` on a later prompt.
 */
function claudeOpens(rec: Rec, anchor: string, label: string | null): boolean {
  if (rec.promptId !== anchor && rec.uuid !== anchor) return false;
  return isRealPromptRecord(rec) && claudePromptLabel(rec) === label;
}

/**
 * Codex: a named turn opens on its `task_started`. An implicit (`u:L…`) turn carries no id in the
 * file, so its first line is recognised by content: the user message whose prompt is the turn's
 * label, or a compaction. A prompt-less implicit turn — only ever a range's far end — opened on
 * whatever record the tracker counted first: a user message, an answer, or a compaction.
 */
function codexOpens(rec: Rec, boundary: TurnBoundary): boolean {
  const p = (rec.payload ?? {}) as Rec;
  if (boundary === "rollback") return rec.type === "event_msg" && p.type === "thread_rolled_back";
  if (!boundary.anchor.startsWith("u:L")) {
    return rec.type === "event_msg" && p.type === "task_started" && p.turn_id === boundary.anchor;
  }
  if (rec.type === "compacted") return true;
  if (rec.type !== "event_msg") return false;
  const text = userText(p);
  if (boundary.prompt === null) return text !== null || isAnswer(p);
  if (text === null) return false;
  const prompt = promptTextOf(text);
  return prompt !== null && promptFirstLine(prompt) === boundary.prompt;
}

/** Whether `text`, the line at a recorded offset, is still the record the index saw begin there. */
export function lineOpensBoundary(provider: "claude" | "codex", text: string, boundary: TurnBoundary | undefined): boolean {
  if (!boundary) return false;
  const rec = parse(text);
  if (!rec) return false;
  if (provider === "codex") return codexOpens(rec, boundary);
  return boundary !== "rollback" && claudeOpens(rec, boundary.anchor, boundary.prompt);
}
