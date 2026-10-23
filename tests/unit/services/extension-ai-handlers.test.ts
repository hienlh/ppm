import { describe, expect, it } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { extensionApiDeps } from "../../../src/services/extension-api/index.ts";
import { ExtensionCallRegistry } from "../../../src/services/extension-api/extension-call-registry.ts";
import { listExtensionAiModels, registerExtensionAiHandlers } from "../../../src/services/extension-api/extension-ai-handlers.ts";
import { ExtensionAiLimiter } from "../../../src/services/extension-ai/extension-ai-limiter.ts";
import type { ExtensionAiDeps } from "../../../src/services/extension-ai/extension-ai-complete.service.ts";
import { OneShotError } from "../../../src/providers/one-shot-error.ts";
import { CLAUDE_MODEL_IDS } from "../../../src/types/claude-models.ts";
import type { OneShotInput } from "../../../src/types/chat.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

const CALL_A = "11111111-1111-4111-8111-111111111111";
const CALL_B = "22222222-2222-4222-8222-222222222222";
const request = { provider: "claude", model: "claude-haiku-4-5", system: "", prompt: "Hi" };

/** A provider whose calls hang until their signal aborts, recording each signal. */
function hangingAi() {
  const signals: AbortSignal[] = [];
  const ai: ExtensionAiDeps = {
    limiter: new ExtensionAiLimiter(),
    pickAccount: () => ({ accountId: "acc-1" }),
    isKnownExtension: (id) => id === "ext" || id === "other" || id === "@scope/ext",
    now: () => Date.now(),
    provider: () => ({
      completeOnce: (input: OneShotInput) => new Promise((resolve, reject) => {
        signals.push(input.signal!);
        if (input.prompt === "answer") return resolve({ text: "ok", inputTokens: 1, outputTokens: 1 });
        input.signal!.addEventListener("abort", () => reject(new OneShotError("ABORTED", "stopped", { usage: { inputTokens: 4, outputTokens: 0 } })));
      }),
    }),
  };
  return { ai, signals };
}

function channel(ai: ExtensionAiDeps, generation = 1, registry = new ExtensionCallRegistry()) {
  const posted: RpcMessage[] = [];
  const rpc = new RpcChannel((msg) => posted.push(msg), { debug() {}, warn() {}, error() {} });
  registerExtensionAiHandlers(rpc, extensionApiDeps(generation, registry), ai);
  let id = 0;
  const call = (method: string, params: unknown) => {
    const msgId = ++id;
    return rpc.handleMessage({ type: "request", id: msgId, method, params: [params] })
      .then(() => (posted.find((m) => m.type === "response" && m.id === msgId) as RpcResponse).result as any);
  };
  return { call, registry };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("ai:* handlers", () => {
  it("answers with the result, or with a coded error inside the result", async () => {
    const { ai } = hangingAi();
    const { call } = channel(ai);
    expect(await call("ai:complete", { extensionId: "ext", callId: CALL_A, request: { ...request, prompt: "answer" } }))
      .toEqual({ ok: true, result: { text: "ok", inputTokens: 1, outputTokens: 1, provider: "claude", model: "claude-haiku-4-5", accountId: "acc-1" } });
    expect((await call("ai:complete", { extensionId: "ext", callId: CALL_A, request: { ...request, provider: "x" } })).error.code).toBe("BAD_REQUEST");
    expect((await call("ai:complete", { extensionId: "ext", callId: "not-a-uuid", request })).error.code).toBe("BAD_REQUEST");
  });

  it("takes only an installed extension's id, scoped package names included", async () => {
    const { ai } = hangingAi();
    const { call } = channel(ai);
    const answer = { ...request, prompt: "answer" };
    expect((await call("ai:complete", { extensionId: "@scope/ext", callId: CALL_A, request: answer })).ok).toBe(true);
    for (const extensionId of ["not-installed", "ext\nforged", " ext", "x".repeat(300), 42]) {
      expect((await call("ai:complete", { extensionId, callId: CALL_B, request: answer })).error.code).toBe("BAD_REQUEST");
    }
  });

  it("ai:cancel stops the running provider call; another extension cannot cancel it", async () => {
    const { ai, signals } = hangingAi();
    const { call } = channel(ai);
    const running = call("ai:complete", { extensionId: "ext", callId: CALL_A, request });
    await tick();
    expect(await call("ai:cancel", { extensionId: "other", callId: CALL_A })).toEqual({ cancelled: false });
    expect(signals[0]!.aborted).toBe(false);
    expect(await call("ai:cancel", { extensionId: "ext", callId: CALL_A })).toEqual({ cancelled: true });
    expect(signals[0]!.aborted).toBe(true);
    expect((await running).error.code).toBe("ABORTED");
    // The call is gone once it ended: a late cancel finds nothing.
    expect(await call("ai:cancel", { extensionId: "ext", callId: CALL_A })).toEqual({ cancelled: false });
  });

  it("rebuilding the worker aborts every call of its generation, and refuses calls started after", async () => {
    const { ai, signals } = hangingAi();
    const registry = new ExtensionCallRegistry();
    const { call } = channel(ai, 7, registry);
    const first = call("ai:complete", { extensionId: "ext", callId: CALL_A, request });
    const second = call("ai:complete", { extensionId: "ext", callId: CALL_B, request });
    await tick();
    expect(registry.count(7)).toBe(2);
    expect(registry.endGeneration(7)).toBe(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect((await first).error.code).toBe("ABORTED");
    expect((await second).error.code).toBe("ABORTED");
    const late = await call("ai:complete", { extensionId: "ext", callId: "33333333-3333-4333-8333-333333333333", request });
    expect(late.error.code).toBe("ABORTED");
    expect(signals).toHaveLength(2);
  });

  it("refuses a call id already in flight", async () => {
    const { ai } = hangingAi();
    const { call } = channel(ai);
    const running = call("ai:complete", { extensionId: "ext", callId: CALL_A, request });
    await tick();
    expect((await call("ai:complete", { extensionId: "ext", callId: CALL_A, request })).error.code).toBe("BAD_REQUEST");
    await call("ai:cancel", { extensionId: "ext", callId: CALL_A });
    await running;
  });
});

describe("listExtensionAiModels", () => {
  it("lists Claude's models and Codex's, and an empty Codex list when Codex fails", async () => {
    expect(await listExtensionAiModels(async () => ["gpt-6-sol", "gpt-6-mini"])).toEqual({
      claude: [...CLAUDE_MODEL_IDS], codex: ["gpt-6-sol", "gpt-6-mini"],
    });
    expect((await listExtensionAiModels(async () => { throw new Error("no codex"); })).codex).toEqual([]);
  });
});
