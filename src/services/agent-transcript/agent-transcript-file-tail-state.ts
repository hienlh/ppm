/**
 * Per-subscription, per-file read state and the read-a-chunk-of-new-bytes
 * operation shared by catch-up (subscribe) and the live tick.
 *
 * The reported `offset` always sits on a line boundary. Bytes already read
 * from disk but not yet newline-terminated stay in `pendingBytes`, in memory,
 * NOT counted in `offset` — so a client that reconnects with an old cursor
 * and a fresh server-side parser always resumes exactly at a line start. If
 * that were not true, a cursor landing mid-line would either skip the rest of
 * that line forever (offset counted past it) or feed a parser a fragment it
 * cannot make sense of (a fresh parser's own internal buffering, if it had
 * any, would not know a prefix was already spent elsewhere).
 */
import type { TranscriptFileRef } from "./agent-transcript-sources.ts";
import { createAgentTranscriptLineParser } from "../subagent-transcript-merger.ts";
import { createRolloutTailParser } from "../../providers/codex-app-server/codex-rollout-tail-parser.ts";
import { buildEnvelope } from "./agent-transcript-envelope.ts";
import { agentTranscriptFsIo } from "./agent-transcript-fs-io.ts";
import type { AgentTranscriptEnvelope } from "../../shared/agent-transcript-protocol.ts";

export interface FileTailState {
  ref: TranscriptFileRef;
  offset: number;
  pendingBytes: Buffer;
  lastGrowthAt: number;
  claudeParser?: ReturnType<typeof createAgentTranscriptLineParser>;
  codexParser?: ReturnType<typeof createRolloutTailParser>;
}

export function createFileTailState(ref: TranscriptFileRef, startOffset: number, now: number): FileTailState {
  const midFile = startOffset > 0;
  return {
    ref,
    offset: startOffset,
    pendingBytes: Buffer.alloc(0),
    lastGrowthAt: now,
    claudeParser: ref.provider === "claude" ? createAgentTranscriptLineParser({ midFile }) : undefined,
    codexParser: ref.provider === "codex" ? createRolloutTailParser() : undefined,
  };
}

function resetFileTailState(fstate: FileTailState, now: number): void {
  fstate.offset = 0;
  fstate.pendingBytes = Buffer.alloc(0);
  fstate.lastGrowthAt = now;
  fstate.claudeParser = fstate.ref.provider === "claude" ? createAgentTranscriptLineParser({ midFile: false }) : undefined;
  fstate.codexParser = fstate.ref.provider === "codex" ? createRolloutTailParser() : undefined;
}

export interface FeedOutcome {
  envelopes: AgentTranscriptEnvelope[];
  /** Thread ids a Codex card's tail parser discovered since the last feed (nested spawns). */
  links: string[];
}

/** Feed newly-read bytes through the file's parser, advancing `offset` only up to the last complete line. */
function feedChunk(fstate: FileTailState, newChunk: Buffer, now: number): FeedOutcome & { parserReset: boolean } {
  const all = fstate.pendingBytes.length ? Buffer.concat([fstate.pendingBytes, newChunk]) : newChunk;
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl === -1) {
    fstate.pendingBytes = all;
    return { envelopes: [], links: [], parserReset: false };
  }
  const text = all.subarray(0, lastNl + 1).toString("utf8");
  fstate.pendingBytes = all.subarray(lastNl + 1);
  const chunkStartOffset = fstate.offset;
  fstate.offset += lastNl + 1;
  fstate.lastGrowthAt = now;

  const envelopes: AgentTranscriptEnvelope[] = [];
  let idx = 0;

  if (fstate.ref.provider === "claude") {
    for (const line of text.split("\n")) {
      if (!line) continue;
      for (const timed of fstate.claudeParser!.feed(line)) {
        envelopes.push(buildEnvelope(fstate.ref.key, chunkStartOffset, idx++, timed.ev, timed.ts));
      }
    }
    return { envelopes, links: [], parserReset: false };
  }

  const fed = fstate.codexParser!.feed(text);
  for (const e of fed.events) {
    envelopes.push(buildEnvelope(fstate.ref.key, chunkStartOffset, idx++, e.ev, e.ts, e.replace ? true : undefined));
  }
  return { envelopes, links: fed.links, parserReset: fed.reset === true };
}

export interface ProcessFileResult extends FeedOutcome {
  /** The client must discard prior state for this file: truncation, or a Codex compaction/rollback. */
  reset: boolean;
}

/**
 * Read whatever is new for one file (from `fstate.offset` to the file's
 * current size) and return the resulting steps. Handles both reset triggers:
 * a file that shrank below the last known offset (rotated/truncated), and a
 * Codex tail parser reporting its own history was rewritten mid-chunk.
 */
export function processFileTail(fstate: FileTailState, now: number): ProcessFileResult {
  let size: number;
  try {
    size = agentTranscriptFsIo.statSize(fstate.ref.path);
  } catch {
    return { envelopes: [], links: [], reset: false };
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
  if (size <= diskPos) return { envelopes: [], links: [], reset: truncated };

  const chunk = agentTranscriptFsIo.readRange(fstate.ref.path, diskPos, size - diskPos);
  const fed = feedChunk(fstate, chunk, now);
  if (!fed.parserReset) return { envelopes: fed.envelopes, links: fed.links, reset: truncated };

  // The parser's own history was rewritten (Codex compaction/rollback): the
  // events already computed from this chunk reflect a mix of pre- and
  // post-rewrite state, so re-derive the authoritative version from byte 0
  // with a fresh parser rather than trying to patch up what we have.
  resetFileTailState(fstate, now);
  const full = agentTranscriptFsIo.readRange(fstate.ref.path, 0, size);
  const fed2 = feedChunk(fstate, full, now);
  return { envelopes: fed2.envelopes, links: fed2.links, reset: true };
}
