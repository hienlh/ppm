/**
 * Scan of a Codex rollout into turns, resumable where the previous scan stopped.
 *
 * Turn boundaries come from `CodexTurnTracker`, the same rules the history parser stamps with
 * (steered messages stay in their turn, rollback removes whole turns). A Codex turn with no real
 * prompt — a manual `/compact` — is not a turn of its own to the person reading: it belongs to
 * the turn before it. Copies a compaction writes back into the thread
 * (`compacted.replacement_history`) are never read here at all, so they never count.
 *
 * Every string kept is a `detachedCopy`, for the reason given in `turn-index-claude.ts`.
 */
import { CodexTurnTracker } from "../../providers/codex-app-server/codex-turn-tracker.ts";
import { mapRolloutItem } from "../../providers/codex-app-server/codex-rollout-items.ts";
import { promptFirstLine, promptTextOf } from "../../shared/user-prompt-kind.ts";
import type { ByteRange, IndexedTurn, TurnStamp, TurnView } from "./session-turn-types.ts";
import { detachedCopy, readTranscriptLines, SliceClock } from "./turn-line-reader.ts";

interface CodexTurnInfo {
  raw: string;
  startByte: number;
  endByte?: number;
  startedAt: string;
  prompt: string | null;
  messageCount: number;
  closed: boolean;
  compacted: boolean;
}

export interface CodexScanState {
  kind: "codex";
  tracker: CodexTurnTracker;
  info: Map<string, CodexTurnInfo>;
  rolledBack: Set<string>;
  /** Non-empty complete lines seen — what an implicit turn id is numbered by. */
  lineNo: number;
  /** The turn whose range is still open. */
  openRaw: string | null;
}

export function newCodexScanState(): CodexScanState {
  return { kind: "codex", tracker: new CodexTurnTracker(), info: new Map(), rolledBack: new Set(), lineNo: 0, openRaw: null };
}

const SKIPPED_TYPES = new Set(["response_item", "turn_context", "session_meta", "world_state"]);
const HEAD_TYPE_RE = /^\{"timestamp":"[^"]*","type":"([a-z_]+)"/;

/** Note a turn the tracker just put a record in; a new one starts its range on this line. */
function enter(state: CodexScanState, raw: string, start: number, at: string): CodexTurnInfo {
  let info = state.info.get(raw);
  if (!info) {
    if (state.openRaw) {
      const previous = state.info.get(state.openRaw);
      if (previous && previous.endByte === undefined) previous.endByte = start;
    }
    info = { raw, startByte: start, startedAt: detachedCopy(at), prompt: null, messageCount: 0, closed: false, compacted: false };
    state.info.set(raw, info);
    state.openRaw = raw;
  }
  return info;
}

/** The text of a user message record's payload, or null when the record is not one. */
export function userText(payload: Record<string, unknown>): string | null {
  if (payload.type === "user_message") return typeof payload.message === "string" ? payload.message : null;
  if (payload.type !== "item_completed") return null;
  const item = payload.item as { type?: unknown } | undefined;
  if (item?.type !== "UserMessage") return null;
  const mapped = mapRolloutItem(item);
  return mapped.kind === "user" ? mapped.text : null;
}

/** An answer, exactly as the history parser counts one (`CodexTurnTracker.item`). */
export function isAnswer(payload: Record<string, unknown>): boolean {
  if (payload.type === "agent_message") return typeof payload.message === "string";
  const item = payload.item as { type?: unknown } | undefined;
  return payload.type === "item_completed" && item?.type === "AgentMessage" && mapRolloutItem(item).kind === "assistant";
}

function scanRecord(state: CodexScanState, rec: Record<string, unknown>, start: number, lineNo: number): void {
  const at = typeof rec.timestamp === "string" ? rec.timestamp : "";
  if (rec.type === "compacted") {
    enter(state, state.tracker.compacted(lineNo), start, at).compacted = true;
    return;
  }
  if (rec.type !== "event_msg") return;
  const p = (rec.payload ?? {}) as Record<string, unknown>;
  if (p.type === "task_started" && typeof p.turn_id === "string") {
    const raw = detachedCopy(p.turn_id);
    state.tracker.taskStarted(raw);
    enter(state, raw, start, at);
  } else if ((p.type === "task_complete" || p.type === "turn_aborted")) {
    const raw = state.tracker.currentId;
    if (raw && (typeof p.turn_id !== "string" || p.turn_id === raw)) {
      const info = state.info.get(raw);
      if (info) info.closed = true;
    }
    state.tracker.taskEnded(typeof p.turn_id === "string" ? p.turn_id : undefined);
  } else if (p.type === "thread_rolled_back") {
    const open = state.openRaw ? state.info.get(state.openRaw) : undefined;
    if (open && open.endByte === undefined) open.endByte = start;
    state.openRaw = null;
    for (const raw of state.tracker.rollback(typeof p.num_turns === "number" ? p.num_turns : 0)) state.rolledBack.add(raw);
  } else {
    const text = userText(p);
    if (text !== null) {
      const info = enter(state, state.tracker.userMessage(lineNo), start, at);
      info.messageCount++;
      const prompt = info.prompt === null ? promptTextOf(text) : null;
      if (prompt !== null) {
        info.prompt = detachedCopy(promptFirstLine(prompt));
        if (at) info.startedAt = detachedCopy(at);
      }
    } else if (isAnswer(p)) {
      enter(state, state.tracker.item(lineNo), start, at).messageCount++;
    }
  }
}

/** Scan from `fromByte` to the end of the complete lines; returns where the next scan resumes. */
export async function scanCodexRollout(filePath: string, state: CodexScanState, fromByte = 0): Promise<number> {
  const clock = new SliceClock();
  let offset = fromByte;
  for await (const line of readTranscriptLines(filePath, fromByte)) {
    offset = line.end;
    await clock.tick();
    if (!line.text.trim()) continue;
    const lineNo = state.lineNo++;
    const head = HEAD_TYPE_RE.exec(line.text.slice(0, 120));
    if (head && SKIPPED_TYPES.has(head[1]!)) continue;
    let rec: unknown;
    try { rec = JSON.parse(line.text); } catch { continue; }
    if (rec && typeof rec === "object") scanRecord(state, rec as Record<string, unknown>, line.start, lineNo);
  }
  return offset;
}

function rangeOf(info: CodexTurnInfo): ByteRange {
  return { from: info.startByte, to: info.endByte };
}

/** The visible turns of a Codex scan: turns with a prompt, each owning the prompt-less ones after it. */
export function codexTurnView(state: CodexScanState): TurnView {
  const turns: TurnView["turns"] = [];
  const stamps = new Map<string, TurnStamp>();
  for (const raw of state.tracker.turns) {
    const info = state.info.get(raw);
    if (!info) continue;
    if (info.prompt !== null) {
      const turn: IndexedTurn & { ranges: ByteRange[] } = {
        turnId: raw, anchor: raw, startedAt: info.startedAt, prompt: info.prompt,
        messageCount: info.messageCount, startByte: info.startByte, endByte: info.endByte,
        closed: info.closed, compacted: info.compacted, ranges: [rangeOf(info)],
      };
      turns.push(turn);
      stamps.set(raw, { turnId: raw, n: turns.length });
      continue;
    }
    const owner = turns[turns.length - 1];
    if (!owner) continue;
    owner.ranges.push(rangeOf(info));
    owner.messageCount += info.messageCount;
    owner.compacted ||= info.compacted;
    owner.closed = info.closed;
    stamps.set(raw, { turnId: owner.turnId, n: turns.length });
  }
  let starts: Map<number, CodexTurnInfo> | undefined;
  return {
    turns,
    stampOf: (raw) => stamps.get(raw),
    keys: () => stamps.keys(),
    isRolledBack: (turnId) => state.rolledBack.has(turnId),
    // A range ends where the next turn the scan entered starts (rolled back or not), or at a
    // rollback record: those are the only two places `enter` and the rollback branch close one.
    boundaryAt(offset) {
      starts ??= new Map([...state.info.values()].map((info) => [info.startByte, info]));
      const info = starts.get(offset);
      return info ? { anchor: info.raw, prompt: info.prompt } : "rollback";
    },
  };
}

/**
 * What the scan state costs to keep, for the cache's byte budget. Measured in Bun 1.3: a turn's
 * record, its id, its time and its map entry ~450 bytes, plus its label.
 */
export function codexStateBytes(state: CodexScanState): number {
  let bytes = 0;
  for (const info of state.info.values()) bytes += 450 + (info.prompt?.length ?? 0) * 2;
  return bytes;
}
