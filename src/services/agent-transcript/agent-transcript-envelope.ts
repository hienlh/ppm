/**
 * Turn a parsed step (Claude's `TimedChatEvent`, Codex's tail-parser output)
 * into the wire `AgentTranscriptEnvelope`, and split a batch of them into
 * pages small enough for one WS frame.
 */
import type { ChatEvent } from "../../types/chat.ts";
import { redactTruncate } from "../../providers/codex-app-server/codex-redact.ts";
import {
  CATCH_UP_MAX_BYTES, CATCH_UP_MAX_EVENTS, TOOL_OUTPUT_MAX_CHARS,
  type AgentTranscriptEnvelope,
} from "../../shared/agent-transcript-protocol.ts";

/**
 * A history view can afford to show a tool's full output; a window is a new
 * long-lived stream kept open for as long as the card is, so both providers'
 * `tool_result` get the same redaction + 20k cap here regardless of what the
 * underlying parser already did for its own output shape.
 */
export function capToolOutput(ev: ChatEvent): ChatEvent {
  if (ev.type !== "tool_result") return ev;
  const capped = redactTruncate(ev.output, TOOL_OUTPUT_MAX_CHARS);
  return capped === ev.output ? ev : { ...ev, output: capped };
}

/** Assemble one wire envelope for an explicit, already-decided key. */
export function makeEnvelope(k: string, ev: ChatEvent, ts: number, replace?: true): AgentTranscriptEnvelope {
  return {
    ev: capToolOutput(ev),
    ts,
    k,
    ...(replace ? { replace: true as const } : {}),
  };
}

export function buildEnvelope(
  fileKey: string,
  chunkStartOffset: number,
  index: number,
  ev: ChatEvent,
  ts: number,
  replace?: true,
): AgentTranscriptEnvelope {
  return makeEnvelope(`${fileKey}:${chunkStartOffset}:${index}`, ev, ts, replace);
}

/**
 * An envelope tagged with which subscription file it came from and the file
 * offset fully consumed once this specific envelope has been delivered. The
 * hub uses this to attach an exact, per-page cursor — the offset a page's
 * own content corresponds to — rather than the subscription's final offset
 * after the whole tick's read, which a client that only received an earlier
 * page would wrongly treat as "already seen" on reconnect.
 */
export interface TaggedEnvelope {
  envelope: AgentTranscriptEnvelope;
  fileKey: string;
  consumedThrough: number;
}

/**
 * Split `items` into pages of at most `CATCH_UP_MAX_EVENTS` entries and
 * roughly `CATCH_UP_MAX_BYTES` of serialized JSON — "roughly" because the
 * byte count is measured on each candidate event as it's added rather than
 * re-serializing the whole page, which is cheap and close enough for a page
 * size limit. A single event that alone exceeds the byte budget still gets
 * its own page rather than being dropped or blocking forever.
 */
export function paginateTagged(items: TaggedEnvelope[]): TaggedEnvelope[][] {
  if (items.length === 0) return [];
  const pages: TaggedEnvelope[][] = [];
  let i = 0;
  while (i < items.length) {
    let count = 0;
    let bytes = 0;
    while (i + count < items.length && count < CATCH_UP_MAX_EVENTS) {
      const size = JSON.stringify(items[i + count]!.envelope).length;
      if (count > 0 && bytes + size > CATCH_UP_MAX_BYTES) break;
      bytes += size;
      count++;
    }
    const take = count > 0 ? count : 1;
    pages.push(items.slice(i, i + take));
    i += take;
  }
  return pages;
}
