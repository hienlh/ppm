/**
 * The messages of chosen turns, read from just their byte ranges of the transcript.
 *
 * Answering with another turn's text is the one thing this must never do, and a transcript is
 * not always append-only: stripping images rewrites it in place under the same inode, moving
 * every later record. So each range is read once, and those same lines are both checked and
 * parsed: the first must be the record the index saw begin there, and the line at a recorded end
 * must still be the record that followed (`turn-boundary-check.ts`). After the read, the file must
 * still be the one the scan saw — unchanged, or only appended to. Any doubt answers `stale`; the
 * scan is then thrown away, rebuilt, and the read tried once more, and a second doubt is an error.
 *
 * A compaction inside a turn is shown as one `COMPACTED_MARKER` message, never expanded: its
 * summary restates the turns before it.
 */
import { stat } from "node:fs/promises";
import type { ChatMessage } from "../../types/chat.ts";
import { parseJsonlTranscript } from "../jsonl-transcript-parser.ts";
import { parseRolloutJsonlAsync } from "../../providers/codex-app-server/codex-history-async.ts";
import { createLogger } from "../logger.ts";
import { readTranscriptLines, SliceClock } from "./turn-line-reader.ts";
import { fingerprintAt } from "./turn-index-cache.ts";
import { lineOpensBoundary } from "./turn-boundary-check.ts";
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
type Provider = "claude" | "codex";

interface ReadRange {
  from: number;
  to: number;
  /** `to` is where the index saw the next record begin, so the line there can be checked. */
  endRecorded: boolean;
}

/** Set once anything read disagrees with the index; the read is then abandoned. */
interface Verdict {
  stale: boolean;
}

/** Bounded ranges: an open end becomes where the index stopped; the total is capped. */
function boundRanges(ranges: ByteRange[], indexedTo: number): ReadRange[] {
  const out: ReadRange[] = [];
  let budget = MAX_TURN_READ_BYTES;
  for (const r of ranges) {
    const to = Math.min(r.to ?? indexedTo, r.from + budget);
    if (to <= r.from) continue;
    out.push({ from: r.from, to, endRecorded: r.to !== undefined && to === r.to });
    budget -= to - r.from;
    if (budget <= 0) break;
  }
  return out;
}

async function lineAt(path: string, offset: number): Promise<string | null> {
  for await (const line of readTranscriptLines(path, offset)) return line.text;
  return null;
}

/** The lines of one range, read once and checked at both ends; nothing more once one fails. */
async function* checkedLines(path: string, provider: Provider, view: TurnView, range: ReadRange, verdict: Verdict): AsyncGenerator<string> {
  const clock = new SliceClock();
  let first = true;
  for await (const line of readTranscriptLines(path, range.from, range.to)) {
    await clock.tick();
    if (first) {
      first = false;
      if (!lineOpensBoundary(provider, line.text, view.boundaryAt(range.from))) { verdict.stale = true; return; }
    }
    yield line.text;
  }
  if (first) { verdict.stale = true; return; }
  if (range.endRecorded && !lineOpensBoundary(provider, await lineAt(path, range.to) ?? "", view.boundaryAt(range.to))) {
    verdict.stale = true;
  }
}

/** Whether the transcript is still the one the scan read: unchanged, or only appended to. */
async function fileUnchanged(path: string, scan: SessionTurnScan): Promise<boolean> {
  const now = await stat(path).catch(() => null);
  if (!now) return false;
  if (now.size === scan.file.size && now.mtimeMs === scan.file.mtimeMs) return true;
  return now.size >= scan.indexedTo && await fingerprintAt(path, scan.indexedTo).catch(() => "") === scan.file.fingerprint;
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

/** Passes lines through, noting the uuid of every compaction summary among them. */
async function* noteSummaries(lines: AsyncIterable<string>, summaries: Set<string>): AsyncGenerator<string> {
  for await (const text of lines) {
    if (text.includes('"isCompactSummary":true')) {
      try {
        const rec = JSON.parse(text) as { isCompactSummary?: unknown; uuid?: unknown };
        if (rec.isCompactSummary === true && typeof rec.uuid === "string") summaries.add(rec.uuid);
      } catch { /* not a record */ }
    }
    yield text;
  }
}

async function readClaudeTurn(path: string, ranges: ReadRange[], view: TurnView, verdict: Verdict): Promise<ChatMessage[]> {
  const summaries = new Set<string>();
  const messages: ChatMessage[] = [];
  for (const r of ranges) {
    const lines = noteSummaries(checkedLines(path, "claude", view, r, verdict), summaries);
    const parsed = await parseJsonlTranscript(path, undefined, { fromByte: r.from, toByte: r.to, lines });
    if (verdict.stale) return [];
    for (const msg of parsed) messages.push(msg);
  }
  return collapseCompactions(messages, summaries);
}

/** Codex lines are collected (at most `MAX_TURN_READ_BYTES`), then parsed with yields between batches. */
async function readCodexTurn(path: string, ranges: ReadRange[], view: TurnView, verdict: Verdict): Promise<ChatMessage[]> {
  const lines: string[] = [];
  for (const r of ranges) {
    for await (const text of checkedLines(path, "codex", view, r, verdict)) lines.push(text);
    if (verdict.stale) return [];
  }
  return collapseCompactions(await parseRolloutJsonlAsync(lines, undefined, { full: true }), new Set());
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

/** One attempt at reading `turnIds` against `scan`; `stale` when the transcript disagrees with it. */
export async function readTurnsFromScan(scan: SessionTurnScan, turnIds: string[]): Promise<TurnMessages[] | "stale"> {
  const { path, providerId } = scan.session;
  const out: TurnMessages[] = [];
  for (const { turn, summary } of findTurns(scan, turnIds)) {
    const verdict: Verdict = { stale: false };
    const ranges = boundRanges(turn.ranges, scan.indexedTo);
    const messages = providerId === "claude"
      ? await readClaudeTurn(path, ranges, scan.view, verdict)
      : await readCodexTurn(path, ranges, scan.view, verdict);
    if (verdict.stale) return "stale";
    for (const msg of messages) {
      if (msg.synthetic) continue;
      msg.turnId = summary.turnId;
      msg.turnN = summary.n;
    }
    out.push({ turn: summary, messages });
  }
  return await fileUnchanged(path, scan) ? out : "stale";
}

/** The messages of each turn asked for, in the order asked. */
export async function readSessionTurnMessages(ref: SessionRef, turnIds: string[]): Promise<TurnMessages[]> {
  if (turnIds.length > MAX_TURNS_PER_READ) throw new SessionTurnError("invalid", `At most ${MAX_TURNS_PER_READ} turns per read`);
  for (const id of turnIds) if (!TURN_ID_RE.test(id)) throw new SessionTurnError("invalid", "Invalid turn id");
  const scan = await scanSessionTurns(ref);
  const first = await readTurnsFromScan(scan, turnIds);
  if (first !== "stale") return first;
  log.warn(`session=${scan.session.sessionId} transcript changed under the turn index — rebuilding`);
  invalidateSessionTurns(scan.session);
  const second = await readTurnsFromScan(await scanSessionTurns(ref), turnIds);
  if (second === "stale") throw new SessionTurnError("stale", "The transcript changed while it was being read");
  return second;
}
