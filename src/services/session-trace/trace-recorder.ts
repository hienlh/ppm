import { createHash, randomUUID } from "node:crypto";
import { TraceCoalescer, type CoalescedRecord } from "./trace-coalescer.ts";
import { traceWriter } from "./trace-writer.ts";
import { recordTraceAlias, resolveTraceId } from "./session-trace-store.ts";
import type { TraceOrigin, TraceSource } from "../../shared/session-trace.ts";
import type { SendMessageOpts } from "../../types/chat.ts";

/**
 * Records whole runs into the session trace: the input that started a turn, every event the
 * provider emitted, each decision taken on its behalf (approvals, aborts), and how it ended.
 *
 * Nothing here may break a chat. Every entry point swallows its own failures, the stream is
 * observed and never altered, and rows reach SQLite only through the batching writer.
 */

/** A row bigger than this is stored as a head plus its length — a log must not hold one 50 MB event. */
const MAX_ROW_CHARS = 1024 * 1024;
const TRUNCATED_HEAD_CHARS = 64 * 1024;

type StreamEvent = { type: string; [key: string]: unknown };

interface RunState {
  traceId: string;
  providerId: string;
  origin: TraceOrigin;
  coalescer: TraceCoalescer;
  /** Turn the next provider event belongs to; null between turns. */
  currentTurnId: string | null;
  /** Follow-ups sent while a turn was running, each waiting for the turn before it to end. */
  pendingTurnIds: string[];
}

/** Live runs by every id they answer to — the one they started under and any a provider migrated to. */
const liveRuns = new Map<string, RunState>();

let lastWarnAt = 0;
function warn(message: string): void {
  // One broken disk must not print a line per streamed event.
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[session-trace] ${message}`);
}

function safe(what: string, fn: () => void): void {
  try { fn(); } catch (e) { warn(`${what} failed: ${(e as Error)?.message ?? e}`); }
}

function serialise(payload: unknown): string {
  const json = JSON.stringify(payload) ?? "null";
  if (json.length <= MAX_ROW_CHARS) return json;
  const type = (payload as { type?: unknown })?.type;
  return JSON.stringify({ type, truncated: true, originalChars: json.length, head: json.slice(0, TRUNCATED_HEAD_CHARS) });
}

function enqueue(state: Pick<RunState, "traceId" | "providerId" | "origin">, turnId: string | null, source: TraceSource, type: string, ts: number, payload: unknown): void {
  traceWriter.enqueue({
    traceId: state.traceId,
    turnId,
    ts,
    source,
    origin: state.origin,
    providerId: state.providerId,
    refId: null,
    type,
    payloadJson: serialise(payload),
  });
}

function enqueueRecords(state: RunState, turnId: string | null, records: CoalescedRecord[]): void {
  for (const r of records) enqueue(state, turnId, "agent", r.type, r.ts, r.payload);
}

function traceIdFor(sessionId: string): string {
  try { return resolveTraceId(sessionId); } catch { return sessionId; }
}

/** What the user sent, minus anything that would bloat a log: images are described, never copied. */
function userMessagePayload(message: string, opts?: SendMessageOpts): Record<string, unknown> {
  const images = opts?.images?.map((img) => {
    const bytes = Buffer.from(img.data, "base64");
    return { mediaType: img.mediaType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return {
    type: "user_message",
    text: message,
    ...(images?.length ? { images } : {}),
    ...(opts?.imagePaths?.length ? { imagePaths: opts.imagePaths } : {}),
    ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts?.model ? { model: opts.model } : {}),
    ...(opts?.effort ? { effort: opts.effort } : {}),
    ...(opts?.thinkingBudget != null ? { thinkingBudget: opts.thinkingBudget } : {}),
    ...(opts?.maxTurns != null ? { maxTurns: opts.maxTurns } : {}),
    ...(opts?.priority ? { priority: opts.priority } : {}),
  };
}

/** How the added context reached the model: prefixed to the message, or handed to a provider that places it. */
export type ContextVia = "message" | "provider";

/**
 * Context PPM added to what the user typed — the shared provider context. Kept whole: the model
 * saw it, and the instruction files it is built from may read differently by the time anyone
 * looks. Capped at 12 000 characters where it is built, and only sent again when it changes.
 */
function contextPayload(text: string, via: ContextVia): Record<string, unknown> {
  return { type: "context_added", via, chars: text.length, text };
}

export interface TraceRunStart {
  sessionId: string;
  providerId: string;
  origin?: TraceOrigin;
  message: string;
  opts?: SendMessageOpts;
}

/** One provider stream, from the message that opened it to its end. Possibly many turns long. */
export class TraceRun {
  private state: RunState | null = null;
  private ended = false;

  constructor(start: TraceRunStart) {
    safe("run start", () => {
      const turnId = randomUUID();
      const state: RunState = {
        traceId: traceIdFor(start.sessionId),
        providerId: start.providerId,
        origin: start.origin ?? "unknown",
        coalescer: new TraceCoalescer(),
        currentTurnId: turnId,
        pendingTurnIds: [],
      };
      this.state = state;
      liveRuns.set(start.sessionId, state);
      liveRuns.set(state.traceId, state);
      enqueue(state, turnId, "server", "user_message", Date.now(), userMessagePayload(start.message, start.opts));
    });
  }

  get traceId(): string | undefined {
    return this.state?.traceId;
  }

  /** What PPM added to the opening message, once it is known. Nothing to record when nothing was added. */
  contextAdded(text: string | undefined, via: ContextVia): void {
    const state = this.state;
    if (!state || this.ended || !text) return;
    safe("context", () => enqueue(state, state.currentTurnId, "server", "context_added", Date.now(), contextPayload(text, via)));
  }

  /** Record one event the provider yielded. Observes only — the caller yields it unchanged. */
  observe(event: StreamEvent): void {
    const state = this.state;
    if (!state || this.ended) return;
    safe("observe", () => {
      const now = Date.now();
      if (state.currentTurnId === null && state.pendingTurnIds.length > 0) {
        // Anything still open was written between turns; it is not the queued turn's.
        enqueueRecords(state, null, state.coalescer.flush());
        state.currentTurnId = state.pendingTurnIds.shift()!;
      }
      enqueueRecords(state, state.currentTurnId, state.coalescer.push(event, now));
      if (event.type === "session_migrated" && typeof event.newSessionId === "string") {
        // Follow-ups, aborts and the next run all arrive under the new id from here on.
        recordTraceAlias(event.newSessionId, state.traceId);
        liveRuns.set(event.newSessionId, state);
      } else if (event.type === "done") {
        state.currentTurnId = null;
        traceWriter.flush();
      }
    });
  }

  /** The provider threw. The caller rethrows; this only writes it down. */
  fail(error: unknown): void {
    const state = this.state;
    if (!state || this.ended) return;
    safe("fail", () => {
      enqueueRecords(state, state.currentTurnId, state.coalescer.flush());
      enqueue(state, state.currentTurnId, "server", "run_failed", Date.now(), {
        type: "run_failed",
        message: (error as Error)?.message ?? String(error),
      });
    });
  }

  /**
   * The stream is over. `completed` means the provider returned; `consumer_closed` means the
   * reader stopped (a closed CLI, a timeout, a thrown caller) with the stream still open.
   */
  end(outcome: "completed" | "consumer_closed" | "failed"): void {
    const state = this.state;
    if (!state || this.ended) return;
    this.ended = true;
    safe("end", () => {
      enqueueRecords(state, state.currentTurnId, state.coalescer.flush());
      // Every caller but the WebSocket one stops reading at `done`, so ending between turns is
      // how a run normally ends and gets no row. Only a turn left unanswered — the one running,
      // or a follow-up queued behind it — is worth writing down, under that turn.
      const unanswered = state.currentTurnId ?? state.pendingTurnIds[0] ?? null;
      if (unanswered !== null && outcome !== "failed") {
        // no_done: the provider returned mid-turn — aborted, crashed, or never said done.
        const reason = outcome === "consumer_closed" ? "consumer_closed" : "no_done";
        enqueue(state, unanswered, "server", "run_closed", Date.now(), { type: "run_closed", reason });
      }
      for (const [id, s] of liveRuns) if (s === state) liveRuns.delete(id);
      traceWriter.flush();
    });
  }
}

/** Wrap a stream that does not go through ChatService (the API proxy) in the same recording. */
export async function* traceStream<T extends StreamEvent>(start: TraceRunStart, events: AsyncIterable<T>): AsyncIterable<T> {
  const run = new TraceRun(start);
  let outcome: "completed" | "consumer_closed" | "failed" = "consumer_closed";
  try {
    for await (const event of events) {
      run.observe(event);
      yield event;
    }
    outcome = "completed";
  } catch (e) {
    run.fail(e);
    outcome = "failed";
    throw e;
  } finally {
    run.end(outcome);
  }
}

/** Close the block in progress so an input lands after what streamed before it. */
function flushOpenBlock(state: RunState): void {
  enqueueRecords(state, state.currentTurnId, state.coalescer.flush());
}

/**
 * A follow-up pushed into a live stream: it opens a turn of its own. `opts.sharedContext` is the
 * context added to it, recorded right behind the message under the same turn.
 */
export function traceFollowUp(
  sessionId: string,
  providerId: string,
  message: string,
  opts?: SendMessageOpts & { origin?: TraceOrigin; contextVia?: ContextVia },
): void {
  safe("follow-up", () => {
    const turnId = randomUUID();
    const live = liveRuns.get(sessionId);
    const target = live ?? { traceId: traceIdFor(sessionId), providerId, origin: opts?.origin ?? "unknown" };
    if (live) {
      flushOpenBlock(live);
      if (live.currentTurnId === null) {
        live.currentTurnId = turnId;
        // Queued ids still here at an idle point were merged into the turn that just ended.
        live.pendingTurnIds = [];
      } else {
        live.pendingTurnIds.push(turnId);
      }
    }
    const row = { ...target, origin: opts?.origin ?? target.origin };
    enqueue(row, turnId, "server", "user_message", Date.now(), userMessagePayload(message, opts));
    if (opts?.sharedContext) {
      enqueue(row, turnId, "server", "context_added", Date.now(), contextPayload(opts.sharedContext, opts.contextVia ?? "message"));
    }
  });
}

/** A turn (or an idle subprocess) stopped by PPM rather than by the model. */
export function traceAbort(sessionId: string, providerId: string, reason: string, origin: TraceOrigin = "unknown"): void {
  safe("abort", () => {
    const live = liveRuns.get(sessionId);
    if (live) flushOpenBlock(live);
    const target = live ?? { traceId: traceIdFor(sessionId), providerId, origin };
    enqueue(target, live?.currentTurnId ?? null, "server", "turn_aborted", Date.now(), { type: "turn_aborted", reason });
  });
}

/** The answer to an approval request or a question, whoever gave it. */
export function traceApproval(
  sessionId: string,
  providerId: string,
  requestId: string,
  approved: boolean,
  extra: { data?: unknown; reason?: string; origin?: TraceOrigin } = {},
): void {
  safe("approval", () => {
    const live = liveRuns.get(sessionId);
    if (live) flushOpenBlock(live);
    const target = live ?? { traceId: traceIdFor(sessionId), providerId, origin: extra.origin ?? "unknown" };
    enqueue(target, live?.currentTurnId ?? null, "server", "approval_resolved", Date.now(), {
      type: "approval_resolved",
      requestId,
      approved,
      ...(extra.data !== undefined ? { data: extra.data } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    });
  });
}

/** For tests: forget every live run. */
export function _resetTraceRuns(): void {
  liveRuns.clear();
}
