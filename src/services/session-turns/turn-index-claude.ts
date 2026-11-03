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
 */
import { isRealPromptRecord, promptFirstLine, promptTextOf } from "../../shared/user-prompt-kind.ts";
import { TURN_ID_RE, type IndexedTurn, type TurnStamp, type TurnView } from "./session-turn-types.ts";
import { readTranscriptLines, SliceClock } from "./turn-line-reader.ts";

export interface ClaudeScanState {
  kind: "claude";
  turns: IndexedTurn[];
  /** Record uuid → index into `turns`. */
  turnOfUuid: Map<string, number>;
  usedIds: Set<string>;
}

export function newClaudeScanState(): ClaudeScanState {
  return { kind: "claude", turns: [], turnOfUuid: new Map(), usedIds: new Set() };
}

const ASSISTANT_TAIL = '"type":"assistant","uuid":"';
const UUID_RE = /^[0-9a-f-]{36}$/i;

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

function openTurn(state: ClaudeScanState, rec: Record<string, unknown>, uuid: string, start: number): void {
  const promptId = typeof rec.promptId === "string" ? rec.promptId : "";
  const own = promptId && TURN_ID_RE.test(promptId) && !promptId.startsWith("u:") && !state.usedIds.has(promptId);
  const turnId = own ? promptId : `u:${uuid}`;
  state.usedIds.add(turnId);
  const previous = state.turns[state.turns.length - 1];
  if (previous) previous.endByte = start;
  state.turns.push({
    turnId,
    anchor: own ? promptId : uuid,
    startedAt: typeof rec.timestamp === "string" ? rec.timestamp : "",
    prompt: promptFirstLine(promptTextOf(contentText(rec.message)) ?? ""),
    messageCount: 1,
    startByte: start,
  });
  state.turnOfUuid.set(uuid, state.turns.length - 1);
}

function attach(state: ClaudeScanState, uuid: string, counts: boolean): void {
  const current = state.turns.length - 1;
  if (current < 0) return;
  state.turnOfUuid.set(uuid, current);
  if (counts) state.turns[current]!.messageCount++;
}

function scanUserRecord(state: ClaudeScanState, rec: Record<string, unknown>, start: number): void {
  const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
  if (!uuid) return;
  if (rec.type === "assistant") return attach(state, uuid, true);
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
    const userHint = text.slice(0, 512).includes('"type":"user"');
    if (!userHint) {
      const uuid = assistantUuid(text);
      if (uuid) { attach(state, uuid, true); continue; }
      if (!text.includes('"type":"user"') && !text.includes('"type":"assistant"')) continue;
    }
    let rec: unknown;
    try { rec = JSON.parse(text); } catch { continue; }
    if (rec && typeof rec === "object") scanUserRecord(state, rec as Record<string, unknown>, line.start);
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
  };
}

/** What the scan state costs to keep, roughly, for the cache's byte budget. */
export function claudeStateBytes(state: ClaudeScanState): number {
  let prompts = 0;
  for (const turn of state.turns) prompts += turn.prompt.length * 2 + 160;
  return prompts + state.turnOfUuid.size * 96;
}
