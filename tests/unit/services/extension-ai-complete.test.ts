import { describe, expect, it, spyOn } from "bun:test";
import { completeForExtension, defaultExtensionAiDeps, type ExtensionAiDeps, type OneShotProvider } from "../../../src/services/extension-ai/extension-ai-complete.service.ts";
import { ExtensionAiLimiter } from "../../../src/services/extension-ai/extension-ai-limiter.ts";
import { OneShotError } from "../../../src/providers/one-shot-error.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import type { OneShotInput, OneShotResult } from "../../../src/types/chat.ts";
import { JUDGE_A_SCHEMA, JUDGE_B_SCHEMA } from "../../fixtures/future-graph-schemas.ts";

type Answer = OneShotResult | Error | ((input: OneShotInput) => Promise<OneShotResult>);

/** A provider that answers from a script and records what it was asked. */
function scripted(...answers: Answer[]) {
  const calls: OneShotInput[] = [];
  const provider: OneShotProvider = {
    async completeOnce(input) {
      calls.push(input);
      const next = answers.shift();
      if (!next) throw new Error("no more scripted answers");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(input) : next;
    },
  };
  return { provider, calls };
}

function deps(provider: OneShotProvider | undefined, picked: { accountId?: string } = { accountId: "acc-1" }) {
  const asked: { provider: string; explicit?: string }[] = [];
  const d: ExtensionAiDeps = {
    limiter: new ExtensionAiLimiter(),
    provider: () => provider,
    pickAccount: (p, explicit) => { asked.push({ provider: p, explicit }); return picked; },
    isKnownExtension: (id) => id === "ext",
    now: () => Date.now(),
  };
  return { d, asked };
}

const answer = (text: string, extra: Partial<OneShotResult> = {}): OneShotResult => ({ text, inputTokens: 10, outputTokens: 5, ...extra });
const request = (extra: Record<string, unknown> = {}) => ({ provider: "claude", model: "claude-haiku-4-5", system: "Judge.", prompt: "Compare.", ...extra });
const never = new AbortController().signal;
const failure = (p: Promise<unknown>) => p.then(() => null, (e) => e as OneShotError);

describe("completeForExtension", () => {
  it("returns the plan's shape for a plain text call", async () => {
    const { provider, calls } = scripted(answer("Xin chào", { accountId: "acc-1" }));
    const result = await completeForExtension("ext", request(), never, deps(provider).d);
    expect(result).toEqual({ text: "Xin chào", inputTokens: 10, outputTokens: 5, provider: "claude", model: "claude-haiku-4-5", accountId: "acc-1" });
    expect(calls[0]!.systemPrompt).toBe("Judge.");
    expect(calls[0]!.timeoutMs).toBe(180_000);
    expect(calls[0]!.jsonSchema).toBeUndefined();
  });

  it("fills json from a valid answer, and tells the model the schema", async () => {
    const { provider, calls } = scripted(answer('```json\n{"same": true, "score": 0.9, "reason_vi": "giống"}\n```'));
    const result = await completeForExtension("ext", request({ jsonSchema: JUDGE_B_SCHEMA }), never, deps(provider).d);
    expect(result.json).toEqual({ same: true, score: 0.9, reason_vi: "giống" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.jsonSchema).toEqual(JUDGE_B_SCHEMA);
    expect(calls[0]!.systemPrompt).toContain("Judge.");
    expect(calls[0]!.systemPrompt).toContain(JSON.stringify(JUDGE_B_SCHEMA));
  });

  it("prefers the provider's native structured answer", async () => {
    const { provider } = scripted(answer("", { structured: { match_id: null, score: 0.1, reason_vi: "khác" } }));
    const result = await completeForExtension("ext", request({ jsonSchema: JUDGE_A_SCHEMA }), never, deps(provider).d);
    expect(result.json).toEqual({ match_id: null, score: 0.1, reason_vi: "khác" });
  });

  it("retries once with the validation error, then succeeds", async () => {
    const { provider, calls } = scripted(
      answer('{"same": "yes", "score": 2, "reason_vi": "x"}'),
      answer('{"same": true, "score": 0.95, "reason_vi": "x"}'),
    );
    const result = await completeForExtension("ext", request({ jsonSchema: JUDGE_B_SCHEMA }), never, deps(provider).d);
    expect(result.json).toEqual({ same: true, score: 0.95, reason_vi: "x" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain("Compare.");
    expect(calls[1]!.prompt).toContain("$.same must be boolean");
    expect(calls[1]!.prompt).toContain("$.score must be <= 1");
    expect(calls[1]!.timeoutMs!).toBeLessThanOrEqual(180_000);
    expect([result.inputTokens, result.outputTokens]).toEqual([20, 10]);
  });

  it("gives up with BAD_JSON and the raw text after the retry also fails", async () => {
    const { provider, calls } = scripted(answer("không có JSON"), answer('{"same": true}'));
    const error = await failure(completeForExtension("ext", request({ jsonSchema: JUDGE_B_SCHEMA }), never, deps(provider).d));
    expect(error?.code).toBe("BAD_JSON");
    expect(error?.raw).toBe('{"same": true}');
    expect(error?.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(calls).toHaveLength(2);
  });

  it("counts a provider's own structured-output failure as the first attempt", async () => {
    const { provider, calls } = scripted(
      new OneShotError("BAD_JSON", "Claude gave no answer that fits the schema", { usage: { inputTokens: 3, outputTokens: 1 }, raw: "" }),
      answer('{"same": false, "score": 0.2, "reason_vi": "khác"}'),
    );
    const result = await completeForExtension("ext", request({ jsonSchema: JUDGE_B_SCHEMA }), never, deps(provider).d);
    expect(result.json).toEqual({ same: false, score: 0.2, reason_vi: "khác" });
    expect(calls).toHaveLength(2);
    expect(result.inputTokens).toBe(13);
  });

  it("refuses a bad request before anything is queued or spent", async () => {
    const { provider, calls } = scripted();
    const { d, asked } = deps(provider);
    const cases = [
      request({ provider: "gemini" }),
      request({ timeoutMs: 1_000 }),
      request({ timeoutMs: 900_001 }),
      request({ prompt: "x".repeat(400_001) }),
      request({ jsonSchema: { type: "object", description: "x".repeat(70_000) } }),
      request({ jsonSchema: { type: "text" } }),
      request({ webSearch: "yes" }),
      "not an object",
    ];
    for (const c of cases) expect((await failure(completeForExtension("ext", c, never, d)))?.code).toBe("BAD_REQUEST");
    expect(calls).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("names the account the extension asked for to the picker, and uses the longer web default", async () => {
    const { provider, calls } = scripted(answer("ok"));
    const { d, asked } = deps(provider, { accountId: "acc-9" });
    await completeForExtension("ext", request({ accountId: "acc-9", webSearch: true }), never, d);
    expect(asked).toEqual([{ provider: "claude", explicit: "acc-9" }]);
    expect(calls[0]!.accountId).toBe("acc-9");
    expect(calls[0]!.webSearch).toBe(true);
    expect(calls[0]!.timeoutMs).toBe(600_000);
  });

  it("reports a missing provider and passes the picker's NO_ACCOUNT through", async () => {
    expect((await failure(completeForExtension("ext", request(), never, deps(undefined).d)))?.code).toBe("PROVIDER_UNAVAILABLE");
    const { d } = deps(scripted().provider);
    d.pickAccount = () => { throw new OneShotError("NO_ACCOUNT", "No Claude account can take a request right now"); };
    expect((await failure(completeForExtension("ext", request(), never, d)))?.code).toBe("NO_ACCOUNT");
  });

  it("aborting the caller's signal stops the provider call and keeps what it had spent", async () => {
    let providerSignal: AbortSignal | undefined;
    const { provider } = scripted((input) => new Promise((_, reject) => {
      providerSignal = input.signal;
      input.signal!.addEventListener("abort", () => reject(new OneShotError("ABORTED", "cancelled", { usage: { inputTokens: 7, outputTokens: 2 } })));
    }));
    const controller = new AbortController();
    const pending = failure(completeForExtension("ext", request(), controller.signal, deps(provider).d));
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const error = await pending;
    expect(providerSignal?.aborted).toBe(true);
    expect(error?.code).toBe("ABORTED");
    expect(error?.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("finds a one-shot on both real providers", () => {
    expect(defaultExtensionAiDeps.provider("claude")).toBeDefined();
    expect(typeof CodexAppServerProvider.prototype.completeOnce).toBe("function");
  });
});

describe("completeForExtension caller identity and log line", () => {
  const logged = () => {
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
    return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
  };

  it("refuses an extension id that names no installed extension, before any queue is made for it", async () => {
    const { provider, calls } = scripted(answer("ok"));
    const { d, asked } = deps(provider);
    const lanes: string[] = [];
    const acquire = d.limiter.acquire.bind(d.limiter);
    d.limiter.acquire = (key, signal) => { lanes.push(key); return acquire(key, signal); };
    for (const id of ["ext-made-up-1", "ext-made-up-2"]) {
      expect((await failure(completeForExtension(id, request(), never, d)))?.code).toBe("BAD_REQUEST");
    }
    expect([calls.length, asked.length, lanes.length]).toEqual([0, 0, 0]);
  });

  it("refuses a malformed id and never writes it raw into the log", async () => {
    const { d } = deps(scripted().provider);
    d.isKnownExtension = () => true;
    const log = logged();
    try {
      const forged = "ext\n2026-10-23T00:00:00.000Z [INFO] [server] forged line";
      expect((await failure(completeForExtension(forged, request(), never, d)))?.code).toBe("BAD_REQUEST");
      expect(log.lines.some((l) => l.includes("\n"))).toBe(false);
    } finally {
      log.restore();
    }
  });

  it("logs the web searches a call ran alongside its tokens", async () => {
    const { provider } = scripted(answer("ok", { webSearches: 4 }));
    const log = logged();
    try {
      await completeForExtension("ext", request({ webSearch: true }), never, deps(provider).d);
    } finally {
      log.restore();
    }
    const line = log.lines.find((l) => l.includes("ai.complete ext=ext"));
    expect(line).toContain("in=10 out=5 searches=4 outcome=ok");
  });
});
