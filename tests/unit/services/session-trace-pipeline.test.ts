/**
 * The two halves that keep the trace off the event loop: deltas fold into one row per block,
 * and rows go down in one transaction per interval — or at turn end — with a failing write
 * dropped rather than thrown into the chat that produced it.
 */
import { describe, it, expect } from "bun:test";
import { TraceCoalescer, type CoalescedRecord } from "../../../src/services/session-trace/trace-coalescer.ts";
import { TraceWriter } from "../../../src/services/session-trace/trace-writer.ts";
import type { TraceRow } from "../../../src/services/session-trace/session-trace-store.ts";

type Ev = { type: string; [key: string]: unknown };

function run(events: Ev[]): CoalescedRecord[] {
  const c = new TraceCoalescer();
  const out: CoalescedRecord[] = [];
  let t = 0;
  for (const e of events) out.push(...c.push(e, t++));
  out.push(...c.flush());
  return out;
}

function deltas(n: number, type = "text", extra: Record<string, unknown> = {}): Ev[] {
  return Array.from({ length: n }, (_, i) => ({ type, content: `${type[0]}${i} `, ...extra }));
}

describe("TraceCoalescer", () => {
  it("folds 300 deltas into one row whose text is their concatenation, and leaves tools untouched", () => {
    const toolUse = { type: "tool_use", tool: "Read", input: { file_path: "a.ts" }, toolUseId: "t1" };
    const toolResult = { type: "tool_result", output: "contents", toolUseId: "t1" };
    const first = deltas(300);
    const second = deltas(50);
    const done = { type: "done", sessionId: "s", resultSubtype: "success" };

    const records = run([...first, toolUse, toolResult, ...second, done]);

    expect(records.map((r) => r.type)).toEqual(["text", "tool_use", "tool_result", "text", "done"]);
    expect(records[0]!.payload).toEqual({ type: "text", content: first.map((d) => d.content).join("") });
    expect(records[3]!.payload.content).toBe(second.map((d) => d.content).join(""));
    expect(records[1]!.payload).toBe(toolUse);
    expect(records[2]!.payload).toBe(toolResult);
    expect(records[4]!.payload).toBe(done);
  });

  it("starts a new block when the kind changes or another agent speaks", () => {
    const records = run([
      ...deltas(3, "thinking"),
      ...deltas(3, "text"),
      ...deltas(2, "text", { parentToolUseId: "agent-1" }),
      ...deltas(2, "text"),
    ]);
    expect(records.map((r) => [r.type, r.payload.parentToolUseId])).toEqual([
      ["thinking", undefined],
      ["text", undefined],
      ["text", "agent-1"],
      ["text", undefined],
    ]);
  });

  it("keeps a block whole through the SDK's bare signals, counting them on it", () => {
    // What a real Claude turn streams: a `thinking_tokens` tick after every thinking delta.
    const tick = () => ({ type: "system", subtype: "thinking_tokens" });
    const thinking = deltas(40, "thinking");
    const task = { type: "system", subtype: "task_started", taskId: "bg-1" };
    const records = run([
      { type: "system", subtype: "init" },
      tick(),
      ...thinking.flatMap((d) => [d, tick()]),
      task,
      ...deltas(2, "text"),
    ]);
    expect(records.map((r) => r.type)).toEqual(["system", "system", "thinking", "system", "text"]);
    // Outside a block a signal is still a row of its own.
    expect(records.slice(0, 2).map((r) => r.payload.subtype)).toEqual(["init", "thinking_tokens"]);
    expect(records[2]!.payload).toEqual({
      type: "thinking",
      content: thinking.map((d) => d.content).join(""),
      signals: { thinking_tokens: 40 },
    });
    // A system event that carries data is an event, and closes the block like any other.
    expect(records[3]!.payload).toBe(task);
    expect(records[4]!.payload).toEqual({ type: "text", content: "t0 t1 " });
  });

  it("stamps a block with the time of its first delta", () => {
    const c = new TraceCoalescer();
    c.push({ type: "text", content: "a" }, 100);
    c.push({ type: "text", content: "b" }, 200);
    const [block, done] = c.push({ type: "done" }, 300);
    expect(block!.ts).toBe(100);
    expect(done!.ts).toBe(300);
  });

  it("holds nothing back once flushed", () => {
    const c = new TraceCoalescer();
    c.push({ type: "text", content: "a" }, 1);
    expect(c.flush()).toHaveLength(1);
    expect(c.flush()).toHaveLength(0);
  });
});

function fakeWriter(write: (rows: readonly TraceRow[]) => void) {
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const warnings: string[] = [];
  const writer = new TraceWriter({
    write,
    setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    warn: (m) => warnings.push(m),
  });
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { writer, timers, warnings, fire };
}

function row(type: string): TraceRow {
  return { traceId: "s", turnId: "t", ts: 0, source: "agent", origin: "unknown", providerId: null, refId: null, type, payloadJson: "{}" };
}

describe("TraceWriter", () => {
  it("commits a whole streamed turn in one write", () => {
    const writes: TraceRow[][] = [];
    const { writer } = fakeWriter((rows) => writes.push([...rows]));
    const records = run([...deltas(300), { type: "tool_use", tool: "Bash" }, { type: "tool_result", output: "" }, ...deltas(40), { type: "done" }]);
    for (const r of records) writer.enqueue(row(r.type));
    writer.flush(); // turn end
    expect(writes).toHaveLength(1);
    expect(writes[0]!.map((r) => r.type)).toEqual(["text", "tool_use", "tool_result", "text", "done"]);
  });

  it("arms one timer per batch and writes when it fires", () => {
    const writes: number[] = [];
    const { writer, timers, fire } = fakeWriter((rows) => writes.push(rows.length));
    writer.enqueue(row("a"));
    writer.enqueue(row("b"));
    writer.enqueue(row("c"));
    expect(timers).toHaveLength(1);
    expect(writes).toEqual([]);
    fire();
    expect(writes).toEqual([3]);
    writer.enqueue(row("d"));
    expect(timers).toHaveLength(1);
  });

  it("an explicit flush disarms the pending timer", () => {
    const writes: number[] = [];
    const { writer, timers, fire } = fakeWriter((rows) => writes.push(rows.length));
    writer.enqueue(row("a"));
    writer.flush();
    expect(timers[0]!.cleared).toBe(true);
    fire();
    expect(writes).toEqual([1]);
  });

  it("drops a batch the database refuses, and never throws to the caller", () => {
    const { writer, warnings } = fakeWriter(() => { throw new Error("database is locked"); });
    writer.enqueue(row("a"));
    expect(() => writer.flush()).not.toThrow();
    expect(writer.pending).toBe(0);
    expect(warnings[0]).toContain("database is locked");
  });
});
