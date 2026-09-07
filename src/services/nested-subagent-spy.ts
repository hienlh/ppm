/**
 * NestedSubagentSpy — surface nested-agent activity on a live Agent card.
 *
 * The SDK streams a subagent's events with `parent_tool_use_id` only for
 * agents the session itself spawned. When that agent spawns another one
 * (a reviewer running a skill that forks its own worker, a planner calling
 * researchers), the CLI emits nothing for the nested agent — the parent card
 * looks frozen on its last step for as long as the grandchild works, which
 * can be many minutes.
 *
 * The nested agent does keep writing its transcript under
 *   <sessionDir>/subagents/agent-<id>.jsonl
 * with a meta whose `parentAgentId` chains back to the card's agent. While a
 * card is open we tail those transcripts and emit their events stamped with
 * the card's toolUseId, so they render flat inside the card exactly like the
 * live depth-1 children do. Same shape as bashOutputSpy: start on tool_use,
 * poll, stop on tool_result.
 *
 * One poller per session, not per card: the dir scan that finds nested agents
 * is shared across every open card, so N cards cost one scan per tick.
 *
 * Spies live only in memory. A backgrounded agent that outlives the server
 * process (or the session's consumer) loses live nested visibility until the
 * next reload, where the transcript merger restores the same events from disk.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent } from "../types/chat.ts";
import { createAgentTranscriptLineParser } from "./subagent-transcript-merger.ts";
import { groupSubagentsByCard } from "./team-member-activity/subagent-transcript-index.ts";

const POLL_INTERVAL_MS = 1000;
/** Repeated per-file read failures (locked/replaced file) log once per this window. */
const WARN_THROTTLE_MS = 30_000;

interface TranscriptTail {
  bytesRead: number;
  /** Unterminated trailing bytes — kept raw so a split multi-byte char survives. */
  pending: Buffer;
  parser: ReturnType<typeof createAgentTranscriptLineParser>;
}

interface CardSpy {
  /** Tails keyed by nested agentId. */
  tails: Map<string, TranscriptTail>;
  onEvents: (events: ChatEvent[]) => void;
}

interface SessionSpy {
  sessionId: string;
  subagentsDir: string;
  cards: Map<string, CardSpy>;
  intervalId: ReturnType<typeof setInterval>;
  lastWarnAt: number;
}

/** Keyed by sessionId — one poller shared by every open card of that session. */
const sessions = new Map<string, SessionSpy>();

/** Read bytes appended since the last tick; null when nothing new. Throws on I/O error. */
function readAppended(filePath: string, tail: TranscriptTail): Buffer | null {
  const size = statSync(filePath).size;
  if (size <= tail.bytesRead) return null;
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - tail.bytesRead);
    const n = readSync(fd, buf, 0, buf.length, tail.bytesRead);
    tail.bytesRead += n;
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Split pending + chunk into complete lines; the unterminated remainder stays
 * raw in `tail.pending` because a write can land mid-record, even mid-char.
 */
function drainLines(tail: TranscriptTail, chunk: Buffer): string[] {
  const all = tail.pending.length ? Buffer.concat([tail.pending, chunk]) : chunk;
  const lastNl = all.lastIndexOf(0x0a);
  if (lastNl === -1) {
    tail.pending = all;
    return [];
  }
  tail.pending = all.subarray(lastNl + 1);
  return all.subarray(0, lastNl).toString("utf8").split("\n");
}

function warnThrottled(spy: SessionSpy, message: string): void {
  const now = Date.now();
  if (now - spy.lastWarnAt < WARN_THROTTLE_MS) return;
  spy.lastWarnAt = now;
  console.warn(`[nested-spy] session=${spy.sessionId} ${message}`);
}

/** One poll for a session: scan the dir once, then drain each open card's nested tails. */
function tick(spy: SessionSpy): void {
  let groups: ReturnType<typeof groupSubagentsByCard>;
  try {
    groups = groupSubagentsByCard(spy.subagentsDir);
  } catch (e) {
    warnThrottled(spy, `scan failed: ${(e as Error).message}`);
    return;
  }
  for (const [cardToolUseId, card] of spy.cards) {
    const group = groups.get(cardToolUseId);
    if (!group) continue;
    const events: ChatEvent[] = [];
    for (const agent of group) {
      // Depth-1 (the card's own agent) is already streamed live by the SDK.
      if (!agent.parentAgentId) continue;
      let tail = card.tails.get(agent.agentId);
      if (!tail) {
        tail = { bytesRead: 0, pending: Buffer.alloc(0), parser: createAgentTranscriptLineParser() };
        card.tails.set(agent.agentId, tail);
      }
      let chunk: Buffer | null;
      try {
        chunk = readAppended(agent.transcriptPath, tail);
      } catch (e) {
        // A locked or replaced file must not stall the other agents in the group.
        warnThrottled(spy, `read failed for ${agent.agentId}: ${(e as Error).message}`);
        continue;
      }
      if (!chunk) continue;
      for (const line of drainLines(tail, chunk)) {
        for (const timed of tail.parser.feed(line)) {
          events.push(withParent(timed.ev, cardToolUseId));
        }
      }
    }
    if (events.length > 0) card.onEvents(events);
  }
}

/** Stamp a child with the card it belongs to, keeping the event union intact. */
function withParent(ev: ChatEvent, parentToolUseId: string): ChatEvent {
  switch (ev.type) {
    case "text":
    case "thinking":
    case "tool_use":
    case "tool_result":
      return { ...ev, parentToolUseId };
    default:
      return ev;
  }
}

/**
 * Start tailing nested transcripts for an open Agent/Task card.
 * `sessionDir` is …/projects/<slug>/<sessionId>; its subagents/ child may not
 * exist yet — the CLI creates it with the first subagent write, and the scan
 * simply finds nothing until then.
 */
function startSpy(
  sessionId: string,
  cardToolUseId: string,
  sessionDir: string,
  onEvents: (events: ChatEvent[]) => void,
): void {
  let spy = sessions.get(sessionId);
  if (!spy) {
    const created: SessionSpy = {
      sessionId,
      subagentsDir: join(sessionDir, "subagents"),
      cards: new Map(),
      lastWarnAt: 0,
      intervalId: setInterval(() => tick(created), POLL_INTERVAL_MS),
    };
    sessions.set(sessionId, created);
    spy = created;
  }
  if (spy.cards.has(cardToolUseId)) return;
  spy.cards.set(cardToolUseId, { tails: new Map(), onEvents });
  console.log(`[nested-spy] session=${sessionId} started card=${cardToolUseId} (${spy.cards.size} open)`);
}

/** Stop a card's spy, draining whatever landed since the last poll first. */
function stopSpy(cardToolUseId: string): void {
  for (const spy of sessions.values()) {
    if (!spy.cards.has(cardToolUseId)) continue;
    // Final drain covers every open card; the spare work is one scan.
    tick(spy);
    spy.cards.delete(cardToolUseId);
    console.log(`[nested-spy] session=${spy.sessionId} stopped card=${cardToolUseId} (${spy.cards.size} open)`);
    if (spy.cards.size === 0) {
      clearInterval(spy.intervalId);
      sessions.delete(spy.sessionId);
    }
    return;
  }
}

/** Stop every spy for a session (turn ended, session migrated, socket closed). */
function stopAllForSession(sessionId: string): void {
  const spy = sessions.get(sessionId);
  if (!spy) return;
  tick(spy);
  clearInterval(spy.intervalId);
  sessions.delete(sessionId);
  console.log(`[nested-spy] session=${sessionId} stopped all (${spy.cards.size} cards)`);
}

export const nestedSubagentSpy = { startSpy, stopSpy, stopAllForSession };
