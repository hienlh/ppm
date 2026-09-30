/**
 * Per-subscription, per-file read state: what a `FileTailState` carries and
 * how it starts out / gets wiped on a reset. The read-a-chunk-of-new-bytes
 * operation itself (shared by catch-up and the live tick) is
 * `agent-transcript-file-tail-feed.ts` — kept apart so this file stays just
 * the state shape or it would not fit the project's file-size guideline.
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
import { statMtimeSafe } from "./agent-transcript-fs-io.ts";

export interface FileTailState {
  ref: TranscriptFileRef;
  offset: number;
  pendingBytes: Buffer;
  lastGrowthAt: number;
  claudeParser?: ReturnType<typeof createAgentTranscriptLineParser>;
  codexParser?: ReturnType<typeof createRolloutTailParser>;
  /** Codex only: the `k` first issued for a toolUseId, so a later `replace`
   *  record for the same id reuses it instead of minting an unmatchable one
   *  (see `agent-transcript-file-tail-feed.ts`). */
  toolUseKeyById: Map<string, string>;
}

/** Seed idle/liveness tracking from the file's own mtime, not "now" — a window
 *  opened on an already-finished agent must not read as freshly active just
 *  because that is when someone happened to subscribe. */
function initialGrowthAt(path: string, now: number): number {
  return statMtimeSafe(path) ?? now;
}

export function createFileTailState(ref: TranscriptFileRef, startOffset: number, now: number): FileTailState {
  const midFile = startOffset > 0;
  return {
    ref,
    offset: startOffset,
    pendingBytes: Buffer.alloc(0),
    lastGrowthAt: initialGrowthAt(ref.path, now),
    claudeParser: ref.provider === "claude" ? createAgentTranscriptLineParser({ midFile, maxEvents: Infinity }) : undefined,
    codexParser: ref.provider === "codex" ? createRolloutTailParser() : undefined,
    toolUseKeyById: new Map(),
  };
}

/** Wipe a file's tracked state back to "never read": a truncation/rotation or
 *  a Codex compaction/rollback means nothing previously derived from it can
 *  be trusted, so the next read starts over from byte 0 with fresh parsers. */
export function resetFileTailState(fstate: FileTailState, now: number): void {
  fstate.offset = 0;
  fstate.pendingBytes = Buffer.alloc(0);
  fstate.lastGrowthAt = now;
  fstate.claudeParser = fstate.ref.provider === "claude" ? createAgentTranscriptLineParser({ midFile: false, maxEvents: Infinity }) : undefined;
  fstate.codexParser = fstate.ref.provider === "codex" ? createRolloutTailParser() : undefined;
  fstate.toolUseKeyById = new Map();
}
