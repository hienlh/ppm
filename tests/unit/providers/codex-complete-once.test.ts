import { describe, expect, it } from "bun:test";
import { codexCompleteOnce, type OneShotRpcClient } from "../../../src/providers/codex-app-server/codex-complete-once.ts";
import type { JsonRpcNotification, ServerRequest } from "../../../src/providers/codex-app-server/codex-protocol.ts";
import type { OneShotInput } from "../../../src/types/chat.ts";

type TurnScript = "answer" | "hang" | "usage-limit" | "schema-refused" | "exit";

/**
 * An app-server that speaks the one-shot's side of the protocol. Each `turn/start` plays the
 * next script: answer (deltas, a final agentMessage, token usage, turn/completed), hang (never
 * completes), a usage-limit or schema refusal (turn failed), or exit (the process dies).
 */
class FakeAppServer implements OneShotRpcClient {
  requests: { method: string; params: any }[] = [];
  started: { cwd?: string; codexHome?: string } | null = null;
  closed = false;
  private notify_: (n: JsonRpcNotification) => void = () => {};
  private onClose_: (code: number | null) => void = () => {};
  constructor(private turns: TurnScript[]) {}

  start(opts: { cwd?: string; codexHome?: string }) { this.started = opts; }
  onNotification(fn: (n: JsonRpcNotification) => void) { this.notify_ = fn; }
  onServerRequest(_fn: (r: ServerRequest) => void) {}
  onClose(fn: (code: number | null) => void) { this.onClose_ = fn; }
  respondError() {}
  notify() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose_(null);
  }

  private emit(method: string, params: Record<string, unknown> = {}) {
    setTimeout(() => { if (!this.closed) this.notify_({ method, params: { threadId: "t1", ...params } }); }, 1);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "initialize") return {} as T;
    if (method === "thread/start") return { thread: { id: "t1" } } as T;
    if (method === "turn/interrupt") return {} as T;
    if (method !== "turn/start") throw new Error(`unexpected ${method}`);
    const n = this.requests.filter((r) => r.method === "turn/start").length;
    const script = this.turns.shift() ?? "hang";
    const turn = { id: `turn-${n}` };
    this.emit("turn/started", { turn });
    if (script === "answer") {
      this.emit("item/agentMessage/delta", { delta: "{\"a\":" });
      this.emit("item/agentMessage/delta", { delta: "1}" });
      this.emit("item/completed", { item: { type: "agentMessage", id: "m", text: "{\"a\": 1}" } });
      this.emit("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 120 * n, outputTokens: 9 * n }, last: {} } });
      this.emit("turn/completed", { turn: { ...turn, status: "completed" } });
    } else if (script === "usage-limit") {
      this.emit("error", { error: { message: "Reconnecting... 1/5" }, willRetry: true });
      this.emit("error", { error: { message: "You've hit your usage limit. Try again at 4:21 PM." }, willRetry: false });
      this.emit("turn/completed", { turn: { ...turn, status: "failed" } });
    } else if (script === "schema-refused") {
      this.emit("turn/completed", { turn: { ...turn, status: "failed", error: { message: "Invalid schema for response_format 'codex_output_schema'" } } });
    } else if (script === "exit") {
      setTimeout(() => { this.closed = true; this.onClose_(1); }, 1);
    }
    return { turn } as T;
  }

  methods() { return this.requests.map((r) => r.method); }
}

const base: OneShotInput = { prompt: "Q", systemPrompt: "S", model: "gpt-6-mini", timeoutMs: 5_000 };
const run = (server: FakeAppServer, input: Partial<OneShotInput> = {}) =>
  codexCompleteOnce({ ...base, ...input }, { cwd: "/ppm/one-shot", codexHome: "/ppm/codex-accounts/a1", createClient: () => server });
const SCHEMA = { type: "object", properties: { a: { type: "integer" } } };

describe("codexCompleteOnce", () => {
  it("returns the final message, closes the app-server, and asks for a sealed thread", async () => {
    const server = new FakeAppServer(["answer"]);
    expect(await run(server, { jsonSchema: SCHEMA })).toEqual({ text: "{\"a\": 1}", inputTokens: 120, outputTokens: 9 });
    expect(server.closed).toBe(true);
    expect(server.started).toEqual({ cwd: "/ppm/one-shot", codexHome: "/ppm/codex-accounts/a1", purpose: "control" } as any);
    expect(server.methods()).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(server.requests[1]!.params).toEqual({
      cwd: "/ppm/one-shot", model: "gpt-6-mini", sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
      developerInstructions: "S", config: { web_search: "disabled" },
    });
    expect(server.requests[2]!.params).toEqual({
      threadId: "t1", input: [{ type: "text", text: "Q", text_elements: [] }], model: "gpt-6-mini", outputSchema: SCHEMA,
    });
  });

  it("turns web search on for the thread when asked", async () => {
    const server = new FakeAppServer(["answer"]);
    await run(server, { webSearch: true });
    expect(server.requests[1]!.params.config).toEqual({ web_search: "live" });
    expect(server.requests[2]!.params.outputSchema).toBeUndefined();
  });

  it("times out, interrupts the turn and kills the app-server", async () => {
    const server = new FakeAppServer(["hang"]);
    const error = await run(server, { timeoutMs: 30 }).catch((e) => e);
    expect([error.code, error.name]).toEqual(["TIMEOUT", "TimeoutError"]);
    expect(server.methods()).toContain("turn/interrupt");
    expect(server.closed).toBe(true);
  });

  it("an abort mid-turn interrupts it and kills the app-server at once", async () => {
    const server = new FakeAppServer(["hang"]);
    const controller = new AbortController();
    const pending = run(server, { signal: controller.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 15));
    controller.abort();
    const error = await pending;
    expect([error.code, error.name]).toEqual(["ABORTED", "AbortError"]);
    expect(server.requests.find((r) => r.method === "turn/interrupt")!.params).toEqual({ threadId: "t1", turnId: "turn-1" });
    expect(server.closed).toBe(true);
  });

  it("an abort before the call starts no app-server", async () => {
    const server = new FakeAppServer(["answer"]);
    const controller = new AbortController();
    controller.abort();
    expect((await run(server, { signal: controller.signal }).catch((e) => e)).code).toBe("ABORTED");
    expect(server.started).toBeNull();
  });

  it("runs the turn once more without the schema when codex refuses the schema", async () => {
    const server = new FakeAppServer(["schema-refused", "answer"]);
    const result = await run(server, { jsonSchema: SCHEMA });
    expect(result.text).toBe("{\"a\": 1}");
    const turns = server.requests.filter((r) => r.method === "turn/start");
    expect(turns.map((t) => t.params.outputSchema)).toEqual([SCHEMA, undefined]);
    expect(server.closed).toBe(true);
  });

  it("names a usage limit, and reports a dead app-server", async () => {
    const limited = new FakeAppServer(["usage-limit"]);
    expect((await run(limited).catch((e) => e)).code).toBe("RATE_LIMITED");
    expect(limited.closed).toBe(true);
    const dying = new FakeAppServer(["exit"]);
    const error = await run(dying).catch((e) => e);
    expect([error.code, error.message]).toEqual(["PROVIDER_ERROR", "codex subprocess exited"]);
  });
});
