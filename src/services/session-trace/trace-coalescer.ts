/**
 * Turns a provider's event stream into the rows the trace keeps.
 *
 * `text` and `thinking` arrive as stream deltas — a 2 000-token reply is several hundred
 * events — and a row per delta would be ~100x the rows for a replay of *how it streamed*,
 * which nobody asked for. So consecutive deltas of one kind from one author fold into one
 * row per block, and everything else passes through 1:1. The trace's invariant compares
 * final states, which this preserves: concatenating a block's deltas is what the UI does too.
 *
 * The one exception is a bare system signal inside a block: counted on the block's row rather
 * than closing it. The Claude SDK sends `thinking_tokens` between every two thinking deltas,
 * and treating it as an event broke each thinking block into a row per delta — 84 of one real
 * turn's 92 rows.
 */

export interface CoalescedRecord {
  type: string;
  /** When the record began: a block's first delta, or the event itself. */
  ts: number;
  payload: Record<string, unknown>;
}

interface OpenBlock {
  type: "text" | "thinking";
  parentToolUseId?: string;
  content: string;
  ts: number;
  /** Bare system signals that arrived inside the block, by subtype. */
  signals?: Record<string, number>;
}

type StreamEvent = { type: string; [key: string]: unknown };

function isDelta(event: StreamEvent): event is StreamEvent & { type: "text" | "thinking"; content: string } {
  return (event.type === "text" || event.type === "thinking") && typeof event.content === "string";
}

/** A system event carrying nothing but its subtype — the phase signals the provider forwards as-is. */
function isBareSignal(event: StreamEvent): event is StreamEvent & { subtype: string } {
  return event.type === "system" && typeof event.subtype === "string"
    && Object.entries(event).every(([key, value]) => key === "type" || key === "subtype" || value === undefined);
}

export class TraceCoalescer {
  private open: OpenBlock | null = null;

  /** Feed one event; returns the records it completed, in order. */
  push(event: StreamEvent, now: number): CoalescedRecord[] {
    if (isDelta(event)) {
      const parentToolUseId = typeof event.parentToolUseId === "string" ? event.parentToolUseId : undefined;
      // A subagent's text interleaves with its parent's, so the author is part of the block.
      if (this.open && this.open.type === event.type && this.open.parentToolUseId === parentToolUseId) {
        this.open.content += event.content;
        return [];
      }
      const closed = this.flush();
      this.open = { type: event.type, content: event.content, ts: now, ...(parentToolUseId ? { parentToolUseId } : {}) };
      return closed;
    }
    if (this.open && isBareSignal(event)) {
      const signals = (this.open.signals ??= {});
      signals[event.subtype] = (signals[event.subtype] ?? 0) + 1;
      return [];
    }
    const out = this.flush();
    out.push({ type: event.type, ts: now, payload: event });
    return out;
  }

  /** Close the block in progress, if any — at turn end, stream end, or before an input row. */
  flush(): CoalescedRecord[] {
    const block = this.open;
    if (!block) return [];
    this.open = null;
    return [{
      type: block.type,
      ts: block.ts,
      payload: {
        type: block.type,
        content: block.content,
        ...(block.parentToolUseId ? { parentToolUseId: block.parentToolUseId } : {}),
        ...(block.signals ? { signals: block.signals } : {}),
      },
    }];
  }
}
