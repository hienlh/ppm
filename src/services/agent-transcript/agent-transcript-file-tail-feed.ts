/**
 * The read-a-chunk-of-new-bytes operation shared by catch-up (subscribe) and
 * the live tick, over the state shape in `agent-transcript-file-tail-state.ts`.
 *
 * Every line is walked individually (not the whole newly-read chunk at once)
 * so each produced envelope can be tagged with the exact file offset it made
 * complete — the hub needs that to hand a client back a cursor for exactly
 * what it was sent, not for however far the read happened to reach that tick.
 */
import { buildEnvelope } from "./agent-transcript-envelope.ts";
import { agentTranscriptFsIo, statMtimeSafe } from "./agent-transcript-fs-io.ts";
import { codexEnvelope, resetFileTailState, type FileTailState } from "./agent-transcript-file-tail-state.ts";
import type { AgentTranscriptEnvelope } from "../../shared/agent-transcript-protocol.ts";

/** Upper bound on bytes read from one file in one tick, so a multi-MB backlog
 *  (a long teammate transcript, a large Codex rollout) cannot block the event
 *  loop for the whole gap in one call — the remainder is picked up, as a plain
 *  continuation (not another reset), on the next tick. */
const PER_TICK_READ_BUDGET_BYTES = 512 * 1024;

export interface FeedOutcome {
  envelopes: AgentTranscriptEnvelope[];
  /** Same length/order as `envelopes`: the file offset fully consumed once that envelope has been delivered. */
  consumedThrough: number[];
  /** Thread ids a Codex card's tail parser discovered since the last feed (nested spawns). */
  links: string[];
}

/**
 * Feed newly-read bytes through the file's parser, advancing `offset` only
 * up to the last complete line. `growthAt` seeds/updates `lastGrowthAt` from
 * the file's own mtime rather than "now" — reading a large, long-existing
 * backlog for the very first time (a window opened on an already-finished
 * agent) must not read as fresh activity just because THIS subscription is
 * only just now catching up on it.
 */
function feedChunk(fstate: FileTailState, newChunk: Buffer, growthAt: number): FeedOutcome & { parserReset: boolean } {
  const all = fstate.pendingBytes.length ? Buffer.concat([fstate.pendingBytes, newChunk]) : newChunk;
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl === -1) {
    fstate.pendingBytes = all;
    return { envelopes: [], consumedThrough: [], links: [], parserReset: false };
  }
  const consumed = all.subarray(0, lastNl + 1);
  fstate.pendingBytes = all.subarray(lastNl + 1);
  const chunkStartOffset = fstate.offset;
  fstate.offset += consumed.length;
  fstate.lastGrowthAt = growthAt;

  const envelopes: AgentTranscriptEnvelope[] = [];
  const consumedThrough: number[] = [];
  const links: string[] = [];
  let idx = 0;
  let parserReset = false;
  let pos = 0;
  let fileOffset = chunkStartOffset;

  while (pos < consumed.length) {
    const nl = consumed.indexOf(0x0a, pos);
    if (nl === -1) break; // unreachable: `consumed` always ends at a real newline
    const lineBuf = consumed.subarray(pos, nl);
    fileOffset += nl - pos + 1;
    pos = nl + 1;
    const line = lineBuf.toString("utf8").trim();
    if (!line) continue;

    if (fstate.ref.provider === "claude") {
      for (const timed of fstate.claudeParser!.feed(line)) {
        envelopes.push(buildEnvelope(fstate.ref.key, chunkStartOffset, idx++, timed.ev, timed.ts));
        consumedThrough.push(fileOffset);
      }
      continue;
    }

    const fed = fstate.codexParser!.feed(`${line}\n`);
    if (fed.reset) {
      // A compaction/rollback record inside THIS SAME read means everything
      // accumulated from earlier lines of it is no longer authoritative —
      // the parser already dropped its own de-dupe state for this; the
      // per-line loop just does the same to what it had already pushed out.
      envelopes.length = 0;
      consumedThrough.length = 0;
      fstate.toolUseKeyById.clear();
      parserReset = true;
    }
    for (const e of fed.events) {
      const freshKey = `${fstate.ref.key}:${chunkStartOffset}:${idx++}`;
      envelopes.push(codexEnvelope(fstate, freshKey, e));
      consumedThrough.push(fileOffset);
    }
    links.push(...fed.links);
  }

  return { envelopes, consumedThrough, links, parserReset };
}

export interface ProcessFileResult extends FeedOutcome {
  /** The client must discard prior state for this file: truncation, or a Codex compaction/rollback. */
  reset: boolean;
  /**
   * True when the file still has unread bytes past `PER_TICK_READ_BUDGET_BYTES`
   * after this call. The tick scheduler must keep polling at the live cadence
   * while this is true — a finished-but-large transcript (idle by mtime, so
   * `running: false`) would otherwise drain in slow idle-cadence chunks
   * instead of catching up as fast as the budget allows.
   */
  hasMoreBacklog: boolean;
}

const EMPTY_RESULT: FeedOutcome = { envelopes: [], consumedThrough: [], links: [] };

/**
 * Read whatever is new for one file (from `fstate.offset` up to at most
 * `PER_TICK_READ_BUDGET_BYTES` past it) and return the resulting steps.
 * Handles both reset triggers: a file that shrank below the last known
 * offset (rotated/truncated), and a Codex tail parser reporting its own
 * history was rewritten mid-chunk. Never throws — a locked or vanished file,
 * or a raced read past a boundary, degrades to "nothing new this tick"
 * rather than reaching the caller (a single bad file must not take the
 * whole subscription, or the process, down with it).
 */
export function processFileTail(fstate: FileTailState, now: number): ProcessFileResult {
  let size: number;
  try {
    size = agentTranscriptFsIo.statSize(fstate.ref.path);
  } catch {
    return { ...EMPTY_RESULT, reset: false, hasMoreBacklog: false };
  }

  let truncated = false;
  if (size < fstate.offset) {
    resetFileTailState(fstate, now);
    truncated = true;
  }

  let diskPos = fstate.offset + fstate.pendingBytes.length;
  if (size < diskPos) {
    fstate.pendingBytes = Buffer.alloc(0);
    diskPos = fstate.offset;
  }
  if (size <= diskPos) return { ...EMPTY_RESULT, reset: truncated, hasMoreBacklog: false };

  const growthAt = statMtimeSafe(fstate.ref.path) ?? now;
  const toRead = Math.min(size - diskPos, PER_TICK_READ_BUDGET_BYTES);
  let chunk: Buffer;
  try {
    chunk = agentTranscriptFsIo.readRange(fstate.ref.path, diskPos, toRead);
  } catch {
    return { ...EMPTY_RESULT, reset: truncated, hasMoreBacklog: size > diskPos };
  }

  const fed = feedChunk(fstate, chunk, growthAt);
  const remainderAfterNormalRead = size > fstate.offset + fstate.pendingBytes.length;
  if (!fed.parserReset) {
    return {
      envelopes: fed.envelopes, consumedThrough: fed.consumedThrough, links: fed.links,
      reset: truncated, hasMoreBacklog: remainderAfterNormalRead,
    };
  }

  // The parser's own history was rewritten (Codex compaction/rollback): the
  // events already computed from this chunk reflect a mix of pre- and
  // post-rewrite state, so re-derive the authoritative version from byte 0
  // with a fresh parser rather than trying to patch up what we have. Bounded
  // by the same read budget — a huge rewritten file resumes as a plain
  // continuation (not another reset) on the next tick.
  resetFileTailState(fstate, now);
  let full: Buffer;
  try {
    full = agentTranscriptFsIo.readRange(fstate.ref.path, 0, Math.min(size, PER_TICK_READ_BUDGET_BYTES));
  } catch {
    return { ...EMPTY_RESULT, reset: true, hasMoreBacklog: size > 0 };
  }
  const fed2 = feedChunk(fstate, full, growthAt);
  const remainderAfterResync = size > fstate.offset + fstate.pendingBytes.length;
  return {
    envelopes: fed2.envelopes, consumedThrough: fed2.consumedThrough, links: fed2.links,
    reset: true, hasMoreBacklog: remainderAfterResync,
  };
}
