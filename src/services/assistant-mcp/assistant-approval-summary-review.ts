import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import type { TurnRevertFile } from "../../shared/session-file-changes.ts";
import { unnamedChat } from "../assistant-watch/watched-chat-title.ts";
import { chatFact, exactFact, fact } from "./assistant-approval-summary.ts";

/**
 * The cards of `chat_changes_answer`: keeping, reverting, reverting a turn and undoing. Pure, built
 * from the change list, the turn preview and the undo journal as PPM worked them out — never from
 * the agent's words. Every path is shown whole: a cut path could name another file.
 */

const HEADLINE_TITLE_CHARS = 80;

export interface ReviewChatOnCard {
  project: string;
  sessionId: string;
  title: string | null;
}

/** One file as a keep or revert card shows it: its lines, or which of its blocks. */
export interface ReviewFileOnCard {
  path: string;
  added?: number;
  removed?: number;
  /** Blocks named, and how many the file has; absent when the whole file is answered. */
  blocks?: { named: number; of: number };
}

export const REVERT_WARNING = "Changes the files on disk; undo is available afterwards from this chat's review.";

const nameOf = (c: ReviewChatOnCard) => {
  const name = c.title || unnamedChat(c.sessionId);
  return name.length > HEADLINE_TITLE_CHARS ? `${name.slice(0, HEADLINE_TITLE_CHARS)}…` : name;
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const chatFacts = (c: ReviewChatOnCard): ApprovalFact[] => [fact("Project", c.project), chatFact(c.title, c.sessionId)];

/** `+3 −1`, or `blocks 2 of 5`. */
export function describeReviewFile(f: ReviewFileOnCard): string {
  if (f.blocks) return `blocks ${f.blocks.named} of ${f.blocks.of}`;
  return f.added === undefined && f.removed === undefined ? "lines not counted" : `+${f.added ?? 0} −${f.removed ?? 0}`;
}

const fileFacts = (files: ReviewFileOnCard[]) => files.map((f) => exactFact("File", `${f.path} (${describeReviewFile(f)})`));

export function reviewKeepSummary(chat: ReviewChatOnCard, files: ReviewFileOnCard[]): ApprovalSummary {
  return {
    headline: `Keep ${plural(files.length, "file")} as chat "${nameOf(chat)}" changed them`,
    facts: [...chatFacts(chat), ...fileFacts(files)],
    warning: "Kept changes count as reviewed; the chat's review stops listing them.",
  };
}

export function reviewRevertSummary(chat: ReviewChatOnCard, files: ReviewFileOnCard[]): ApprovalSummary {
  return {
    headline: `Put back ${plural(files.length, "file")} as they were before chat "${nameOf(chat)}" changed them`,
    facts: [...chatFacts(chat), ...fileFacts(files)],
    warning: REVERT_WARNING,
  };
}

/** What reverting a turn does to one file, in words. */
export function describeTurnRevertFile(f: TurnRevertFile): string {
  const left = f.skipped.length ? `; ${plural(f.skipped.length, "change")} left as they are (changed since)` : "";
  if (f.error) return `nothing: ${f.error}`;
  if (f.action === "delete") return `deleted (the turn created it)${left}`;
  if (f.action === "restore") return `brought back (the turn deleted it)${left}`;
  if (f.action === "edit") return `${plural(f.changes, "change")} put back (+${f.added} −${f.removed})${left}`;
  return `nothing to put back${left}`;
}

export function reviewRevertTurnSummary(
  chat: ReviewChatOnCard,
  turn: { n: number; at: string; prompt: string },
  files: TurnRevertFile[],
): ApprovalSummary {
  return {
    headline: `Put back what turn ${turn.n} of chat "${nameOf(chat)}" changed in ${plural(files.length, "file")}`,
    facts: [
      ...chatFacts(chat),
      fact("Turn", `${turn.n} · ${turn.at} · ${turn.prompt}`),
      ...files.map((f) => exactFact("File", `${f.path}: ${describeTurnRevertFile(f)}`, f.action === "delete" ? "warning" : undefined)),
    ],
    warning: REVERT_WARNING,
  };
}

export function reviewUndoSummary(
  chat: ReviewChatOnCard,
  undo: { undoId: string; createdAt: string; files: Array<{ path: string; wroteFile: boolean }> },
): ApprovalSummary {
  const writes = undo.files.some((f) => f.wroteFile);
  return {
    headline: `Undo an answer given in chat "${nameOf(chat)}"'s review (${plural(undo.files.length, "file")})`,
    facts: [
      ...chatFacts(chat),
      exactFact("Answer", `${undo.undoId}${undo.createdAt ? `, given ${undo.createdAt}` : ""}`),
      ...undo.files.map((f) => exactFact("File", `${f.path} (${f.wroteFile ? "written back on disk" : "review marks only"})`)),
    ],
    ...(writes ? { warning: "Changes the files on disk back to what they were before that answer." } : {}),
  };
}
