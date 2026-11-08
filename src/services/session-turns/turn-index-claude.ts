/**
 * Scan of a Claude transcript into turns, resumable where the previous scan stopped.
 *
 * A raw `promptId` is not a turn: the CLI stamps one on task notifications, on its own
 * "Continue from where you left off.", on interrupted tool results and on image companions —
 * some of them carrying the *next* prompt's id. So a turn starts only at a real prompt record
 * (`isRealPromptRecord`), takes that record's `promptId` (`u:<uuid>` when it has none or the id
 * is already taken), and every other record belongs to the newest turn by file position.
 *
 * Assistant records are the bulk of a transcript and are never parsed here: their uuid sits at
 * the end of the line right after `"type":"assistant"`, past the message and anything a tool
 * input could quote. User records are parsed, since the prompt decision needs their content.
 *
 * Every string kept is a `detachedCopy`: a slice of a line, or a value parsed out of one, would
 * otherwise keep the whole line in memory for as long as the cache keeps the scan.
 */
import { isRealPromptRecord, promptFirstLine, promptTextOf } from "../../shared/user-prompt-kind.ts";
import { TURN_ID_RE, type IndexedTurn, type TurnStamp, type TurnView } from "./session-turn-types.ts";
import { detachedCopy, readTranscriptLines, SliceClock } from "./turn-line-reader.ts";

export interface ClaudeScanState {
  kind: "claude";
  turns: IndexedTurn[];
  /** Record uuid → index into `turns`. */
  turnOfUuid: Map<string, number>;
  usedIds: Set<string>;
  /**
   * API message id of the newest assistant reply counted in the current turn. The CLI writes one
   * record per content block — thinking, text, each tool call — all under the reply's one id, and
   * the chat shows them as one message.
   */
  lastReplyId: string | null;
}

export function newClaudeScanState(): ClaudeScanState {
  return { kind: "claude", turns: [], turnOfUuid: new Map(), usedIds: new Set(), lastReplyId: null };
}

const ASSISTANT_TAIL = '"type":"assistant","uuid":"';
const UUID_RE = /^[0-9a-f-]{36}$/i;
/** `message.id` of an assistant record: written before the content, so the head holds it. */
const REPLY_ID_RE = /"message":\{[^{}]*?"id":"(msg_[A-Za-z0-9_-]{1,80})"/;
const REPLY_ID_HEAD = 1024;

/** The uuid of an assistant record, read from the line's tail without parsing it. */
function assistantUuid(text: string): string | null {
  const at = text.lastIndexOf(ASSISTANT_TAIL);
  if (at === -1) return null;
  const from = at + ASSISTANT_TAIL.length;
  const uuid = text.slice(from, text.indexOf('"', from));
  return UUID_RE.test(uuid) ? uuid : null;
}

function contentText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
}

/** The one-line label of a prompt record, as the index stores it on the turn. */
export function claudePromptLabel(rec: Record<string, unknown>): string {
  return promptFirstLine(promptTextOf(contentText(rec.message)) ?? "");
}

function openTurn(state: ClaudeScanState, rec: Record<string, unknown>, uuid: string, start: number): void {
  const promptId = typeof rec.promptId === "string" ? rec.promptId : "";
  const own = promptId && TURN_ID_RE.test(promptId) && !promptId.startsWith("u:") && !state.usedIds.has(promptId);
  const anchor = detachedCopy(own ? promptId : uuid);
  const turnId = own ? anchor : `u:${anchor}`;
  state.usedIds.add(turnId);
  const previous = state.turns[state.turns.length - 1];
  if (previous) previous.endByte = start;
  state.turns.push({
    turnId,
    anchor,
    startedAt: typeof rec.timestamp === "string" ? detachedCopy(rec.timestamp) : "",
    prompt: detachedCopy(claudePromptLabel(rec)),
    messageCount: 1,
    startByte: start,
  });
  state.lastReplyId = null;
  state.turnOfUuid.set(detachedCopy(uuid), state.turns.length - 1);
}

/** Put a record in the newest turn; `counts` when the chat shows it as a message of its own. */
function attach(state: ClaudeScanState, uuid: string, counts: boolean): void {
  const current = state.turns.length - 1;
  if (current < 0) return;
  state.turnOfUuid.set(detachedCopy(uuid), current);
  if (counts) state.turns[current]!.messageCount++;
}

/** An assistant record: one message per reply, however many block records the reply took. */
function attachReply(state: ClaudeScanState, uuid: string, replyId: string | null): void {
  const sameReply = replyId !== null && replyId === state.lastReplyId;
  if (replyId !== null && !sameReply && state.turns.length) state.lastReplyId = detachedCopy(replyId);
  attach(state, uuid, !sameReply);
}

function scanRecord(state: ClaudeScanState, rec: Record<string, unknown>, start: number): void {
  const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
  if (!uuid) return;
  if (rec.type === "assistant") {
    const id = (rec.message as { id?: unknown } | undefined)?.id;
    return attachReply(state, uuid, typeof id === "string" ? id : null);
  }
  if (rec.type !== "user") return;
  if (isRealPromptRecord(rec)) return openTurn(state, rec, uuid, start);
  if (rec.isCompactSummary === true) {
    const current = state.turns[state.turns.length - 1];
    if (current) current.compacted = true;
  }
  const content = (rec.message as { content?: unknown } | undefined)?.content;
  const toolResultOnly = Array.isArray(content) && content.every((b) => (b as { type?: unknown })?.type === "tool_result");
  attach(state, uuid, !toolResultOnly && rec.isMeta !== true);
}

/**
 * Scan from `fromByte` (a line start the previous scan ended on, or 0) to the end of the
 * complete lines. Returns the offset the next scan resumes at.
 */
export async function scanClaudeTranscript(filePath: string, state: ClaudeScanState, fromByte = 0): Promise<number> {
  const clock = new SliceClock();
  let offset = fromByte;
  for await (const line of readTranscriptLines(filePath, fromByte)) {
    offset = line.end;
    await clock.tick();
    const text = line.text;
    // `"type":"user"` precedes the message in a user record, so it shows in the head. A head
    // match on anything else is caught after parsing, which is what the type is read from.
    const head = text.slice(0, REPLY_ID_HEAD);
    if (!head.slice(0, 512).includes('"type":"user"')) {
      const uuid = assistantUuid(text);
      if (uuid) { attachReply(state, uuid, REPLY_ID_RE.exec(head)?.[1] ?? null); continue; }
      if (!text.includes('"type":"user"') && !text.includes('"type":"assistant"')) continue;
    }
    let rec: unknown;
    try { rec = JSON.parse(text); } catch { continue; }
    if (rec && typeof rec === "object") scanRecord(state, rec as Record<string, unknown>, line.start);
  }
  return offset;
}

/** The turns of a Claude scan. A Claude transcript has no rollback, so none is ever rolled back. */
export function claudeTurnView(state: ClaudeScanState): TurnView {
  return {
    turns: state.turns.map((turn) => ({ ...turn, ranges: [{ from: turn.startByte, to: turn.endByte }] })),
    stampOf(uuid: string): TurnStamp | undefined {
      const index = state.turnOfUuid.get(uuid);
      const turn = index === undefined ? undefined : state.turns[index];
      return turn ? { turnId: turn.turnId, n: index! + 1 } : undefined;
    },
    keys: () => state.turnOfUuid.keys(),
    isRolledBack: () => false,
    boundaryAt(offset: number) {
      const turn = state.turns[firstTurnAtOrAfter(state.turns, offset)];
      return turn && turn.startByte === offset ? { anchor: turn.anchor, prompt: turn.prompt } : undefined;
    },
  };
}

/** Index of the first turn starting at or after `offset` (turns are in file order). */
function firstTurnAtOrAfter(turns: IndexedTurn[], offset: number): number {
  let lo = 0, hi = turns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid]!.startByte < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * What the scan state costs to keep, for the cache's byte budget. Measured in Bun 1.3: a turn
 * with its three short strings ~400 bytes plus its label, a uuid map entry ~150 bytes.
 */
export function claudeStateBytes(state: ClaudeScanState): number {
  let bytes = 0;
  for (const turn of state.turns) bytes += 400 + turn.prompt.length * 2;
  return bytes + state.turnOfUuid.size * 150;
}
