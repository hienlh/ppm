/**
 * The messages of chosen turns, read from just their byte ranges of the transcript.
 *
 * A range is trusted only after its first line is checked to still be the record the index
 * started the turn on: a transcript rewritten in place (images stripped) can put other records at
 * those offsets, and answering with another turn's text is the one thing this must never do. On a
 * mismatch the scan is thrown away, rebuilt, and the read tried once more; a second mismatch is
 * `stale`.
 *
 * A compaction inside a turn is shown as one `COMPACTED_MARKER` message, never expanded: its
 * summary restates the turns before it.
 */
import type { ChatMessage } from "../../types/chat.ts";
import { parseJsonlTranscript } from "../jsonl-transcript-parser.ts";
import { parseRolloutJsonl } from "../../providers/codex-app-server/codex-history.ts";
import { createLogger } from "../logger.ts";
import { readTranscriptLines } from "./turn-line-reader.ts";
import {
  invalidateSessionTurns, scanSessionTurns, summarizeTurns, type SessionRef, type SessionTurnScan,
} from "./session-turn-index.service.ts";
import {
  COMPACTED_MARKER, SessionTurnError, TURN_ID_RE, type ByteRange, type SessionTurnSummary, type TurnView,
} from "./session-turn-types.ts";

const log = createLogger("session-turns");

/** Most bytes one turn is read from; a longer turn is read from its start up to this. */
const MAX_TURN_READ_BYTES = 64 * 1024 * 1024;
/** Turns one call may ask for. */
export const MAX_TURNS_PER_READ = 20;

export interface TurnMessages {
  turn: SessionTurnSummary;
  messages: ChatMessage[];
}

type ViewTurn = TurnView["turns"][number];

/** Whether the first record of `range` is still the one the turn was indexed on. */
async function anchorHolds(path: string, provider: "claude" | "codex", turn: ViewTurn): Promise<boolean> {
  const range = turn.ranges[0]!;
  for await (const line of readTranscriptLines(path, range.from, range.to)) {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line.text) as Record<string, unknown>; } catch { return false; }
    if (provider === "claude") return rec.promptId === turn.anchor || rec.uuid === turn.anchor;
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    if (turn.anchor.startsWith("u:L")) return rec.type === "event_msg" && (p.type === "user_message" || p.type === "item_completed");
    return rec.type === "event_msg" && p.type === "task_started" && p.turn_id === turn.anchor;
  }
  return false;
}

/** Bounded ranges: an open end becomes where the index stopped; the total is capped. */
function boundRanges(ranges: ByteRange[], indexedTo: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let budget = MAX_TURN_READ_BYTES;
  for (const r of ranges) {
    const to = Math.min(r.to ?? indexedTo, r.from + budget);
    if (to <= r.from) continue;
    out.push({ from: r.from, to });
    budget -= to - r.from;
    if (budget <= 0) break;
  }
  return out;
}

/** Turn a compaction summary (Claude) or marker (Codex) into one marker, consecutive ones merged. */
function collapseCompactions(messages: ChatMessage[], summaryUuids: Set<string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const isCompaction = (msg.synthetic && msg.content === COMPACTED_MARKER) || (!!msg.sdkUuid && summaryUuids.has(msg.sdkUuid)) || !!msg.compaction;
    if (!isCompaction) { out.push(msg); continue; }
    if (out[out.length - 1]?.content === COMPACTED_MARKER) continue;
    out.push({ id: `${msg.id}:compacted`, role: "system", content: COMPACTED_MARKER, timestamp: msg.timestamp, synthetic: true });
  }
  return out;
}

async function readClaudeTurn(path: string, ranges: Array<{ from: number; to: number }>): Promise<ChatMessage[]> {
  const summaries = new Set<string>();
  for (const r of ranges) {
    for await (const line of readTranscriptLines(path, r.from, r.to)) {
      if (!line.text.includes('"isCompactSummary":true')) continue;
      try {
        const rec = JSON.parse(line.text) as { isCompactSummary?: unknown; uuid?: unknown };
        if (rec.isCompactSummary === true && typeof rec.uuid === "string") summaries.add(rec.uuid);
      } catch { /* not a record */ }
    }
  }
  const messages: ChatMessage[] = [];
  for (const r of ranges) messages.push(...await parseJsonlTranscript(path, undefined, { fromByte: r.from, toByte: r.to }));
  return collapseCompactions(messages, summaries);
}

async function readCodexTurn(path: string, ranges: Array<{ from: number; to: number }>): Promise<ChatMessage[]> {
  let text = "";
  for (const r of ranges) for await (const line of readTranscriptLines(path, r.from, r.to)) text += `${line.text}\n`;
  return collapseCompactions(parseRolloutJsonl(text, { full: true }), new Set());
}

function findTurns(scan: SessionTurnScan, turnIds: string[]): Array<{ turn: ViewTurn; summary: SessionTurnSummary }> {
  const summaries = summarizeTurns(scan);
  return turnIds.map((turnId) => {
    const index = scan.view.turns.findIndex((t) => t.turnId === turnId);
    if (index !== -1) return { turn: scan.view.turns[index]!, summary: summaries[index]! };
    if (scan.view.isRolledBack(turnId)) throw new SessionTurnError("rolled_back", `Turn ${turnId} was rolled back`);
    throw new SessionTurnError("not_found", `No turn ${turnId} in this session`);
  });
}

async function readOnce(scan: SessionTurnScan, turnIds: string[]): Promise<TurnMessages[] | "stale"> {
  const { path, providerId } = scan.session;
  const out: TurnMessages[] = [];
  for (const { turn, summary } of findTurns(scan, turnIds)) {
    if (!await anchorHolds(path, providerId, turn)) return "stale";
    const ranges = boundRanges(turn.ranges, scan.indexedTo);
    const messages = providerId === "claude" ? await readClaudeTurn(path, ranges) : await readCodexTurn(path, ranges);
    for (const msg of messages) {
      if (msg.synthetic) continue;
      msg.turnId = summary.turnId;
      msg.turnN = summary.n;
    }
    out.push({ turn: summary, messages });
  }
  return out;
}

/** The messages of each turn asked for, in the order asked. */
export async function readSessionTurnMessages(ref: SessionRef, turnIds: string[]): Promise<TurnMessages[]> {
  if (turnIds.length > MAX_TURNS_PER_READ) throw new SessionTurnError("invalid", `At most ${MAX_TURNS_PER_READ} turns per read`);
  for (const id of turnIds) if (!TURN_ID_RE.test(id)) throw new SessionTurnError("invalid", "Invalid turn id");
  const scan = await scanSessionTurns(ref);
  const first = await readOnce(scan, turnIds);
  if (first !== "stale") return first;
  log.warn(`session=${scan.session.sessionId} transcript changed under the turn index — rebuilding`);
  invalidateSessionTurns(scan.session);
  const second = await readOnce(await scanSessionTurns(ref), turnIds);
  if (second === "stale") throw new SessionTurnError("stale", "The transcript changed while it was being read");
  return second;
}
