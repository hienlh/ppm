/**
 * The trace's invariant, asserted: anything PPM renders from a run can be rebuilt from PPM's
 * own log. A run is reduced to its final state twice — once from the provider's raw stream,
 * once from the rows `readEvents` returns — and the two must be equal, with the inputs (the
 * message, each follow-up, approvals, aborts) present and the stream itself left untouched.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { closeTraceDb } from "../../../src/services/session-trace/session-trace-db.ts";
import { readEvents, resolveTraceId, type TraceEvent } from "../../../src/services/session-trace/session-trace-store.ts";
import { _resetTraceRuns } from "../../../src/services/session-trace/trace-recorder.ts";
import type { AIProvider, ChatEvent, Session, SendMessageOpts } from "../../../src/types/chat.ts";
import { withSharedContext } from "../../../src/shared/provider-context.ts";

type Ev = ChatEvent | { type: "system"; subtype: string };

/** A provider that plays a fixed script and, like the real ones, keeps a stream open for follow-ups. */
class ScriptedProvider implements AIProvider {
  id = "trace-script";
  name = "Trace script";
  /** Every event yielded, in order — what the trace is compared against. */
  yielded: Ev[] = [];
  turns: Ev[][] = [];
  failAfter: number | null = null;
  private queue: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  approvals: Array<[string, boolean, unknown]> = [];
  blockOnApproval = false;
  /** Every text the provider was handed, context included — what the model actually saw. */
  messages: string[] = [];
  /** Where ChatService looks up a session's project, as it does in a real provider. */
  sessions = new Map<string, Session>();

  async createSession(): Promise<Session> {
    return { id: crypto.randomUUID(), providerId: this.id, title: "t", createdAt: new Date().toISOString() };
  }
  async resumeSession(id: string): Promise<Session> {
    return { id, providerId: this.id, title: "t", createdAt: new Date().toISOString() };
  }
  async listSessions() { return []; }
  async deleteSession() {}

  async *sendMessage(_sessionId: string, message: string, _opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    this.messages.push(message);
    let turn = 0;
    for (;;) {
      for (const ev of this.turns[turn] ?? []) {
        if (this.failAfter !== null && this.yielded.length >= this.failAfter) throw new Error("subprocess exited with code 1");
        this.yielded.push(ev);
        yield ev as ChatEvent;
        // Like canUseTool: the stream blocks until the request is answered.
        if (ev.type === "approval_request" && this.blockOnApproval) {
          while (!this.approvals.some(([id]) => id === ev.requestId)) await new Promise<void>((r) => { this.wake = r; });
        }
      }
      turn++;
      if (turn >= this.turns.length) return;
      // Wait for a follow-up before playing the next turn, as a streaming session does.
      while (this.queue.length === 0 && !this.closed) await new Promise<void>((r) => { this.wake = r; });
      if (this.closed) return;
      this.queue.shift();
    }
  }

  pushMessage(_sessionId: string, content: string): void {
    this.messages.push(content);
    this.queue.push(content);
    this.wake?.();
  }
  abortQuery(): void {
    this.closed = true;
    this.wake?.();
  }
  resolveApproval(requestId: string, approved: boolean, data?: unknown): void {
    this.approvals.push([requestId, approved, data]);
    this.wake?.();
  }
}

const deltas = (n: number, type: "text" | "thinking", extra: Record<string, unknown> = {}): Ev[] =>
  Array.from({ length: n }, (_, i) => ({ type, content: `${type}-${i} `, ...extra }) as Ev);

/** The Claude SDK's bare progress signal, sent between every two thinking deltas. */
const tick = (): Ev => ({ type: "system", subtype: "thinking_tokens" }) as Ev;

function turnScript(sessionId: string): Ev[] {
  return [
    { type: "system", subtype: "init" },
    ...deltas(40, "thinking").flatMap((d) => [d, tick()]),
    ...deltas(120, "text"),
    { type: "tool_use", tool: "Agent", input: { prompt: "look" }, toolUseId: "agent-1" },
    ...deltas(15, "text", { parentToolUseId: "agent-1" }),
    { type: "tool_result", output: "found it", toolUseId: "agent-1" },
    { type: "approval_request", requestId: "req-1", tool: "Bash", input: { command: "ls" } },
    ...deltas(60, "text"),
    { type: "done", sessionId, resultSubtype: "success", numTurns: 1 },
  ];
}

/** A system event with nothing but its subtype: a phase signal the UI never renders. */
const isBareSignal = (ev: Record<string, unknown>) =>
  ev.type === "system" && Object.keys(ev).every((k) => k === "type" || k === "subtype");

/** The UI's view of a run: consecutive deltas by one author are one block; bare signals show nothing. */
function reduce(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of events) {
    if (isBareSignal(raw)) continue;
    const { signals: _signals, ...ev } = raw;
    const last = out[out.length - 1];
    const isDelta = ev.type === "text" || ev.type === "thinking";
    if (isDelta && last && last.type === ev.type && last.parentToolUseId === ev.parentToolUseId) {
      last.content = `${last.content}${ev.content}`;
    } else {
      out.push({ ...ev });
    }
  }
  return out;
}

const agentRows = (rows: TraceEvent[]) => rows.filter((r) => r.source === "agent");
const payloads = (rows: TraceEvent[]) => rows.map((r) => r.payload as Record<string, unknown>);

let provider: ScriptedProvider;
const tempDirs: string[] = [];
const originalHome = process.env.PPM_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ppm-trace-replay-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeTraceDb();
  _resetPpmDir();
  _resetTraceRuns();
  provider = new ScriptedProvider();
  providerRegistry.register(provider);
});

afterAll(() => {
  (providerRegistry as unknown as { providers: Map<string, AIProvider> }).providers.delete("trace-script");
  closeTraceDb();
  process.env.PPM_HOME = originalHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* sqlite handles linger on windows */ }
  }
});

async function drain(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("a run rebuilt from the trace", () => {
  it("equals the provider's stream reduced to its final state, inputs first and done last", async () => {
    const sessionId = crypto.randomUUID();
    provider.turns = [turnScript(sessionId)];
    const image = Buffer.from("not really a png");

    const seen = await drain(chatService.sendMessage("trace-script", sessionId, "find the bug", {
      origin: "cli",
      permissionMode: "plan",
      images: [{ data: image.toString("base64"), mediaType: "image/png" }],
    }));

    // The stream is observed, never altered: the very objects the provider yielded, in order.
    expect(seen).toHaveLength(provider.yielded.length);
    seen.forEach((ev, i) => expect(ev).toBe(provider.yielded[i] as ChatEvent));

    const rows = readEvents(sessionId);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows[0]!.type).toBe("user_message");
    expect(rows[rows.length - 1]!.type).toBe("done");
    expect(rows[0]!.payload).toEqual({
      type: "user_message",
      text: "find the bug",
      permissionMode: "plan",
      images: [{ mediaType: "image/png", bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") }],
    });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(image.toString("base64"));

    expect(reduce(payloads(agentRows(rows)))).toEqual(reduce(provider.yielded as Array<Record<string, unknown>>));
    // Every signal is accounted for: a row of its own outside a block, a count on the block inside one.
    const signalCount = (evs: Array<Record<string, unknown>>) => evs.reduce((n, ev) =>
      n + (isBareSignal(ev) && ev.subtype === "thinking_tokens" ? 1 : 0)
        + (((ev.signals as Record<string, number> | undefined)?.thinking_tokens) ?? 0), 0);
    expect(signalCount(payloads(agentRows(rows)))).toBe(signalCount(provider.yielded as Array<Record<string, unknown>>));
    // Coalesced: 235 deltas and 40 signals became a handful of rows.
    expect(rows.length).toBeLessThan(15);
    expect(new Set(rows.map((r) => r.turnId)).size).toBe(1);
    expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(["cli"]));
    expect(new Set(rows.map((r) => r.providerId))).toEqual(new Set(["trace-script"]));
  });

  it("gives each follow-up its own turn, and keeps one trace across a provider's rename", async () => {
    const sessionId = crypto.randomUUID();
    provider.turns = [
      [{ type: "session_migrated", oldSessionId: sessionId, newSessionId: "thread-9" }, ...deltas(5, "text"), { type: "done", sessionId: "thread-9" }],
      [...deltas(7, "text"), { type: "done", sessionId: "thread-9" }],
    ];
    const stream = drain(chatService.sendMessage("trace-script", sessionId, "first", { origin: "ws" }));
    while (provider.yielded.length < 7) await Bun.sleep(1);
    // After the rename every later input arrives under the provider's id.
    await chatService.pushMessage("trace-script", "thread-9", "second", { origin: "ws" });
    await stream;

    expect(resolveTraceId("thread-9")).toBe(sessionId);
    const rows = readEvents(sessionId);
    expect(readEvents("thread-9")).toEqual([]);
    expect(rows.map((r) => r.type)).toEqual(["user_message", "session_migrated", "text", "done", "user_message", "text", "done"]);
    const [firstTurn, secondTurn] = [rows[0]!.turnId, rows[4]!.turnId];
    expect(firstTurn).not.toBe(secondTurn);
    expect(rows.slice(0, 4).every((r) => r.turnId === firstTurn)).toBe(true);
    expect(rows.slice(4).every((r) => r.turnId === secondTurn)).toBe(true);
    expect((rows[4]!.payload as { text: string }).text).toBe("second");
  });

  it("records approvals and aborts, which never pass through the stream", async () => {
    const sessionId = crypto.randomUUID();
    provider.turns = [
      [{ type: "approval_request", requestId: "req-7", tool: "Bash", input: { command: "rm x" } }, ...deltas(3, "text"), { type: "done", sessionId }],
      [...deltas(2, "text"), { type: "done", sessionId }],
    ];
    provider.blockOnApproval = true;
    const stream = drain(chatService.sendMessage("trace-script", sessionId, "go", { origin: "ws" }));
    while (provider.yielded.length < 1) await Bun.sleep(1);
    chatService.resolveApproval("trace-script", sessionId, "req-7", true, { answer: "yes" }, { origin: "ws" });
    while (provider.yielded.length < 5) await Bun.sleep(1);
    chatService.abortQuery("trace-script", sessionId, "ws_cancel", "ws");
    await stream;

    expect(provider.approvals).toEqual([["req-7", true, { answer: "yes" }]]);
    const rows = readEvents(sessionId);
    expect(rows.map((r) => r.type)).toEqual(["user_message", "approval_request", "approval_resolved", "text", "done", "turn_aborted"]);
    expect(rows[2]!.payload).toEqual({ type: "approval_resolved", requestId: "req-7", approved: true, data: { answer: "yes" } });
    expect(rows[5]!.payload).toEqual({ type: "turn_aborted", reason: "ws_cancel" });
    // Aborted between turns: it belongs to no turn.
    expect(rows[5]!.turnId).toBeNull();
  });

  it("says how a run ended when it did not end with done", async () => {
    const closedId = crypto.randomUUID();
    provider.turns = [[...deltas(10, "text"), { type: "done", sessionId: closedId }]];
    for await (const ev of chatService.sendMessage("trace-script", closedId, "hi", { origin: "cli" })) {
      if (ev.type === "text") break; // Ctrl+C in `ppm chat`
    }
    const closed = readEvents(closedId);
    expect(closed.map((r) => r.type)).toEqual(["user_message", "text", "run_closed"]);
    expect(closed[2]!.payload).toEqual({ type: "run_closed", reason: "consumer_closed" });

    provider = new ScriptedProvider();
    providerRegistry.register(provider);
    const failedId = crypto.randomUUID();
    provider.turns = [[...deltas(4, "text"), { type: "done", sessionId: failedId }]];
    provider.failAfter = 2;
    await expect(drain(chatService.sendMessage("trace-script", failedId, "hi", { origin: "scheduler" }))).rejects.toThrow("subprocess exited");
    const failed = readEvents(failedId);
    expect(failed.map((r) => r.type)).toEqual(["user_message", "text", "run_failed"]);
    expect(failed[2]!.payload).toEqual({ type: "run_failed", message: "subprocess exited with code 1" });
  });

  it("keeps the context PPM added to a message, since the model saw it and its files can change", async () => {
    const home = tempDirs[tempDirs.length - 1]!;
    const project = join(home, "project");
    mkdirSync(project);
    // Only the project's own file: nothing from the real ~/.claude may crowd it out.
    const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(home, "claude-empty");
    try {
      writeFileSync(join(project, "CLAUDE.md"), "Always remove dead code.");
      const sessionId = crypto.randomUUID();
      provider.sessions.set(sessionId, { id: sessionId, providerId: provider.id, projectPath: project, title: "t", createdAt: "" });
      const turn = (n: number): Ev[] => [...deltas(n, "text"), { type: "done", sessionId }];
      provider.turns = [turn(2), turn(1), turn(1)];

      const stream = drain(chatService.sendMessage("trace-script", sessionId, "first", { origin: "ws" }));
      while (provider.yielded.length < 3) await Bun.sleep(1);
      writeFileSync(join(project, "CLAUDE.md"), "Never delete a file.");
      await chatService.pushMessage("trace-script", sessionId, "second", { origin: "ws" });
      while (provider.yielded.length < 5) await Bun.sleep(1);
      // Unchanged since the last turn: the provider gets no second copy, and neither does the log.
      await chatService.pushMessage("trace-script", sessionId, "third", { origin: "ws" });
      await stream;

      const rows = readEvents(sessionId);
      expect(rows.map((r) => r.type)).toEqual([
        "user_message", "context_added", "text", "done",
        "user_message", "context_added", "text", "done",
        "user_message", "text", "done",
      ]);
      const added = rows.filter((r) => r.type === "context_added");
      expect(added.map((r) => r.turnId)).toEqual([rows[0]!.turnId, rows[4]!.turnId]);
      const [first, second] = added.map((r) => r.payload as { via: string; chars: number; text: string });
      expect(first!.text).toContain("Always remove dead code.");
      expect(second!.text).toContain("Never delete a file.");
      expect([first!.via, second!.via]).toEqual(["message", "message"]);
      expect(first!.chars).toBe(first!.text.length);
      // Exactly what reached the provider ahead of the user's own text.
      expect(provider.messages).toEqual([
        withSharedContext("first", first!.text),
        withSharedContext("second", second!.text),
        "third",
      ]);
    } finally {
      if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
    }
  });

  it("stopping at done is a normal end, unless a follow-up was left unanswered", async () => {
    // The scheduler, ppmbot, the CLI, jira and group chat all break at done: a row there would
    // sit under every scheduled run looking like a fault.
    const normalId = crypto.randomUUID();
    provider.turns = [[...deltas(3, "text"), { type: "done", sessionId: normalId }], [{ type: "done", sessionId: normalId }]];
    for await (const ev of chatService.sendMessage("trace-script", normalId, "hi", { origin: "scheduler" })) {
      if (ev.type === "done") break;
    }
    expect(readEvents(normalId).map((r) => r.type)).toEqual(["user_message", "text", "done"]);

    provider = new ScriptedProvider();
    providerRegistry.register(provider);
    const leftId = crypto.randomUUID();
    provider.turns = [[...deltas(3, "text"), { type: "done", sessionId: leftId }], [...deltas(2, "text"), { type: "done", sessionId: leftId }]];
    let pushed = false;
    for await (const ev of chatService.sendMessage("trace-script", leftId, "first", { origin: "ppmbot" })) {
      if (ev.type === "text" && !pushed) {
        pushed = true;
        await chatService.pushMessage("trace-script", leftId, "second", { origin: "ppmbot" });
      }
      if (ev.type === "done") break;
    }
    const rows = readEvents(leftId);
    expect(rows.map((r) => r.type)).toEqual(["user_message", "text", "user_message", "text", "done", "run_closed"]);
    expect(rows[5]!.payload).toEqual({ type: "run_closed", reason: "consumer_closed" });
    // Filed under the turn nobody answered, not the one that finished.
    expect(rows[5]!.turnId).toBe(rows[2]!.turnId);
    expect(rows[5]!.turnId).not.toBe(rows[0]!.turnId);
  });

  it("an unknown provider is still a run: the error PPM showed is in the log", async () => {
    const sessionId = crypto.randomUUID();
    const seen = await drain(chatService.sendMessage("no-such-provider", sessionId, "hi", { origin: "jira" }));
    expect(seen).toEqual([{ type: "error", message: 'Provider "no-such-provider" not found' }]);
    expect(readEvents(sessionId).map((r) => r.type)).toEqual(["user_message", "error", "run_closed"]);
  });

  it("a trace database that cannot open costs the chat nothing", async () => {
    // PPM_HOME pointing at a file: every open of the trace database throws ENOTDIR.
    const blocker = join(tempDirs[tempDirs.length - 1]!, "not-a-dir");
    writeFileSync(blocker, "");
    process.env.PPM_HOME = blocker;
    _resetPpmDir();
    closeTraceDb();
    const sessionId = crypto.randomUUID();
    provider.turns = [turnScript(sessionId)];
    const seen = await drain(chatService.sendMessage("trace-script", sessionId, "hi", { origin: "cli" }));
    expect(seen).toHaveLength(provider.yielded.length);
    expect(seen[seen.length - 1]!.type).toBe("done");
  });
});
