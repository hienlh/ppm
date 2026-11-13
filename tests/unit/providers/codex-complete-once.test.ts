import { afterEach, describe, expect, it } from "bun:test";
import { codexCompleteOnce, type OneShotRpcClient } from "../../../src/providers/codex-app-server/codex-complete-once.ts";
import type { JsonRpcNotification, ServerRequest } from "../../../src/providers/codex-app-server/codex-protocol.ts";
import { _resetCodexAuthFailuresForTesting, isCodexAccountAuthFailed, markCodexAccountAuthFailed } from "../../../src/services/codex-account-auth-state.ts";
import { _resetCodexCooldownsForTesting, codexUsageLimitResetAt, isCodexAccountUsageLimited } from "../../../src/services/codex-account-cooldown.ts";
import type { OneShotInput } from "../../../src/types/chat.ts";

type TurnScript = "answer" | "hang" | "usage-limit" | "schema-refused" | "exit" | "subagent" | "signed-out" | "web";

/**
 * An app-server that speaks the one-shot's side of the protocol. Each `thread/start` hands out
 * a new thread id (t1, t2, …); each `turn/start` plays the next script on the thread it names:
 * answer (deltas, a final agentMessage, token usage, turn/completed), hang (never completes), a
 * usage-limit or schema refusal (turn failed), exit (the process dies), subagent (a child
 * thread answers and completes first), signed-out (a 401 retry notice, then silence) or web (two
 * searches, then an answer).
 */
class FakeAppServer implements OneShotRpcClient {
  requests: { method: string; params: any }[] = [];
  started: { cwd?: string; codexHome?: string } | null = null;
  closed = false;
  /** Holds `initialize` or `thread/start` open until the test lets it go. */
  holdMethod: string | null = null;
  /** The user's `config.toml` MCP servers `config/read` reports; `null` makes the read fail. */
  userMcpServers: Record<string, unknown> | null = {};
  private threads = 0;
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

  private emit(threadId: string, method: string, params: Record<string, unknown> = {}, delay = 1) {
    setTimeout(() => { if (!this.closed) this.notify_({ method, params: { threadId, ...params } }); }, delay);
  }

  private answer(threadId: string, turn: { id: string }, n: number, text = "{\"a\": 1}") {
    this.emit(threadId, "item/agentMessage/delta", { delta: text });
    this.emit(threadId, "item/completed", { item: { type: "agentMessage", id: "m", text } });
    this.emit(threadId, "thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 120 * n, outputTokens: 9 * n }, last: {} } });
    this.emit(threadId, "turn/completed", { turn: { ...turn, status: "completed" } });
  }

  async request<T>(method: string, params?: any): Promise<T> {
    this.requests.push({ method, params });
    if (method === this.holdMethod) return new Promise<T>(() => {});
    if (method === "initialize") return {} as T;
    if (method === "config/read") {
      if (!this.userMcpServers) throw new Error("unknown method config/read");
      return { config: { mcp_servers: this.userMcpServers } } as T;
    }
    if (method === "thread/start") return { thread: { id: `t${++this.threads}` } } as T;
    if (method === "turn/interrupt") return {} as T;
    if (method !== "turn/start") throw new Error(`unexpected ${method}`);
    const n = this.requests.filter((r) => r.method === "turn/start").length;
    const script = this.turns.shift() ?? "hang";
    const turn = { id: `turn-${n}` };
    const t = params.threadId as string;
    this.emit(t, "turn/started", { turn });
    if (script === "answer") {
      this.answer(t, turn, n);
    } else if (script === "subagent") {
      this.emit("child", "item/completed", { item: { type: "agentMessage", id: "c", text: "child text" } });
      this.emit("child", "thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 999, outputTokens: 99 } } });
      this.emit("child", "turn/completed", { turn: { id: "child-turn", status: "completed" } });
      setTimeout(() => this.answer(t, turn, n, "parent text"), 20);
    } else if (script === "web") {
      this.emit(t, "item/completed", { item: { type: "webSearch", id: "w1", query: "a" } });
      this.emit(t, "item/completed", { item: { type: "webSearch", id: "w2", query: "b" } });
      this.answer(t, turn, n);
    } else if (script === "signed-out") {
      this.emit(t, "error", {
        error: { message: "Reconnecting... 1/5", additionalDetails: "workspace routing discovery unauthorized (401)" },
        willRetry: true,
      });
    } else if (script === "usage-limit") {
      this.emit(t, "error", { error: { message: "Reconnecting... 1/5" }, willRetry: true });
      this.emit(t, "error", { error: { message: "You've hit your usage limit. Try again in 3 hours." }, willRetry: false });
      this.emit(t, "turn/completed", { turn: { ...turn, status: "failed" } });
    } else if (script === "schema-refused") {
      this.emit(t, "turn/completed", { turn: { ...turn, status: "failed", error: { message: "Invalid schema for response_format 'codex_output_schema'" } } });
    } else if (script === "exit") {
      setTimeout(() => { this.closed = true; this.onClose_(1); }, 1);
    }
    return { turn } as T;
  }

  methods() { return this.requests.map((r) => r.method); }
}

const base: OneShotInput = { prompt: "Q", systemPrompt: "S", model: "gpt-6-mini", timeoutMs: 5_000 };
const run = (server: FakeAppServer, input: Partial<OneShotInput> = {}, accountId?: string) =>
  codexCompleteOnce({ ...base, ...input }, {
    cwd: "/ppm/one-shot", codexHome: "/ppm/codex-accounts/a1", ...(accountId && { accountId }), createClient: () => server,
  });
const SCHEMA = { type: "object", properties: { a: { type: "integer" } } };
const FEATURES_OFF = {
  "features.shell_tool": false, "features.multi_agent": false, "features.image_generation": false,
  "features.apps": false, "features.plugins": false,
};

afterEach(() => { _resetCodexAuthFailuresForTesting(); _resetCodexCooldownsForTesting(); });

describe("codexCompleteOnce", () => {
  it("returns the final message, closes the app-server, and asks for a sealed thread without shell or subagents", async () => {
    const server = new FakeAppServer(["answer"]);
    expect(await run(server, { jsonSchema: SCHEMA })).toEqual({ text: "{\"a\": 1}", inputTokens: 120, outputTokens: 9 });
    expect(server.closed).toBe(true);
    expect(server.started).toEqual({ cwd: "/ppm/one-shot", codexHome: "/ppm/codex-accounts/a1", purpose: "control" } as any);
    expect(server.methods()).toEqual(["initialize", "config/read", "thread/start", "turn/start"]);
    expect(server.requests[2]!.params).toEqual({
      cwd: "/ppm/one-shot", model: "gpt-6-mini", sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
      developerInstructions: "S", config: { web_search: "disabled", ...FEATURES_OFF },
    });
    expect(server.requests[3]!.params).toEqual({
      threadId: "t1", input: [{ type: "text", text: "Q", text_elements: [] }], model: "gpt-6-mini", outputSchema: SCHEMA,
    });
  });

  it("turns web search on for the thread, keeps the shell off, and counts the searches", async () => {
    const server = new FakeAppServer(["web"]);
    const result = await run(server, { webSearch: true });
    expect(server.requests[2]!.params.config).toEqual({ web_search: "live", ...FEATURES_OFF });
    expect(server.requests[3]!.params.outputSchema).toBeUndefined();
    expect(result.webSearches).toBe(2);
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

  for (const held of ["initialize", "thread/start"]) {
    it(`an abort while waiting on ${held} ends the call and kills the app-server`, async () => {
      const server = new FakeAppServer(["answer"]);
      server.holdMethod = held;
      const controller = new AbortController();
      const pending = run(server, { signal: controller.signal }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      expect((await pending).code).toBe("ABORTED");
      expect(server.closed).toBe(true);
      expect(server.methods()).not.toContain("turn/start");
    });
  }

  it("runs the turn once more without the schema, on a fresh thread, when codex refuses the schema", async () => {
    const server = new FakeAppServer(["schema-refused", "answer"]);
    const result = await run(server, { jsonSchema: SCHEMA });
    expect(result.text).toBe("{\"a\": 1}");
    const turns = server.requests.filter((r) => r.method === "turn/start");
    expect(turns.map((t) => t.params.outputSchema)).toEqual([SCHEMA, undefined]);
    expect(turns.map((t) => t.params.threadId)).toEqual(["t1", "t2"]);
    expect(server.methods().filter((m) => m === "thread/start")).toHaveLength(2);
    expect(server.closed).toBe(true);
  });

  it("an abort during the retry turn interrupts that turn on its own thread", async () => {
    const server = new FakeAppServer(["schema-refused", "hang"]);
    const controller = new AbortController();
    const pending = run(server, { jsonSchema: SCHEMA, signal: controller.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    expect((await pending).code).toBe("ABORTED");
    expect(server.requests.find((r) => r.method === "turn/interrupt")!.params).toEqual({ threadId: "t2", turnId: "turn-2" });
    expect(server.closed).toBe(true);
  });

  it("ignores a spawned thread: its completion does not end the call and its text is not the answer", async () => {
    const server = new FakeAppServer(["subagent"]);
    const result = await run(server);
    expect(result).toEqual({ text: "parent text", inputTokens: 120, outputTokens: 9 });
  });

  it("names a usage limit, parks the account until the reset, and reports a dead app-server", async () => {
    const limited = new FakeAppServer(["usage-limit"]);
    const before = Date.now();
    expect((await run(limited, {}, "acc-limited").catch((e) => e)).code).toBe("RATE_LIMITED");
    expect(limited.closed).toBe(true);
    expect(isCodexAccountUsageLimited("acc-limited")).toBe(true);
    expect(codexUsageLimitResetAt("acc-limited")! - before).toBeGreaterThanOrEqual(3 * 3_600_000 - 1_000);
    const dying = new FakeAppServer(["exit"]);
    const error = await run(dying).catch((e) => e);
    expect([error.code, error.message]).toEqual(["PROVIDER_ERROR", "codex subprocess exited"]);
  });

  it("a signed-out account ends the call at the first retry notice and is benched", async () => {
    const server = new FakeAppServer(["signed-out"]);
    const startedAt = Date.now();
    const error = await run(server, { timeoutMs: 5_000 }, "acc-out").catch((e) => e);
    expect(error.code).toBe("NO_ACCOUNT");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(isCodexAccountAuthFailed("acc-out")).toBe(true);
    expect(server.closed).toBe(true);
  });

  it("an answer clears a stale sign-out mark", async () => {
    markCodexAccountAuthFailed("acc-back", "401 Unauthorized");
    await run(new FakeAppServer(["answer"]), {}, "acc-back");
    expect(isCodexAccountAuthFailed("acc-back")).toBe(false);
  });
});

describe("the user's own MCP servers", () => {
  it("are switched off for the call, one by one, from what config/read reports", async () => {
    const server = new FakeAppServer(["answer"]);
    server.userMcpServers = { github: { command: "gh-mcp" }, "slack-mcp": { url: "http://x" } };
    await run(server);
    const thread = server.requests.find((r) => r.method === "thread/start")!.params;
    expect(thread.config["mcp_servers.github.enabled"]).toBe(false);
    expect(thread.config["mcp_servers.slack-mcp.enabled"]).toBe(false);
    expect(server.methods().indexOf("config/read")).toBeLessThan(server.methods().indexOf("thread/start"));
  });

  it("refuse the call when the config cannot be read, and start no thread", async () => {
    const server = new FakeAppServer(["answer"]);
    server.userMcpServers = null;
    await expect(run(server)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(server.methods()).not.toContain("thread/start");
  });
});
