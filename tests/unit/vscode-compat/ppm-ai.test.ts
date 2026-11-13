import { describe, expect, it } from "bun:test";
import {
  aiCompleteRpcTimeoutMs, createPpmAi, PpmAiError,
  AI_DEFAULT_TIMEOUT_MS, AI_DEFAULT_WEB_TIMEOUT_MS, AI_MAX_QUEUE_WAIT_MS, AI_MAX_TIMEOUT_MS, AI_MIN_TIMEOUT_MS,
} from "../../../packages/vscode-compat/src/ppm/ppm-ai.ts";
import { createPpmNamespace } from "../../../packages/vscode-compat/src/ppm/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";
import * as main from "../../../src/services/extension-ai/extension-ai-request.ts";
import * as mainLimiter from "../../../src/services/extension-ai/extension-ai-limiter.ts";

const request = { provider: "claude" as const, model: "claude-haiku-4-5", system: "", prompt: "Hi" };

function mockRpc(answer: (method: string, params: any) => unknown) {
  const sent: { method: string; timeoutMs?: number; params: any }[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string, ...params: unknown[]) {
      sent.push({ method, params: params[0] });
      return answer(method, params[0]) as T;
    },
    async requestWithTimeout<T>(method: string, timeoutMs: number, ...params: unknown[]) {
      sent.push({ method, timeoutMs, params: params[0] });
      return answer(method, params[0]) as T;
    },
    notify() {},
  };
  return { rpc, sent };
}

describe("ppm.ai", () => {
  it("is the ai area of the ppm namespace", () => {
    expect(typeof createPpmNamespace(mockRpc(() => null).rpc, "probe").ai.complete).toBe("function");
  });

  it("sends one ai:complete with a fresh call id and the queue-aware timeout", async () => {
    const result = { text: "ok", inputTokens: 1, outputTokens: 2, provider: "claude", model: "claude-haiku-4-5" };
    const { rpc, sent } = mockRpc(() => ({ ok: true, result }));
    const ai = createPpmAi(rpc, "probe-ext");
    expect(await ai.complete({ ...request, timeoutMs: 30_000 })).toEqual(result as any);
    await ai.complete(request);
    expect(sent[0]!.method).toBe("ai:complete");
    expect(sent[0]!.timeoutMs).toBe(30_000 + 60_000 + 15_000);
    expect(sent[0]!.params).toMatchObject({ extensionId: "probe-ext", request: { ...request, timeoutMs: 30_000 } });
    expect(sent[0]!.params.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[1]!.params.callId).not.toBe(sent[0]!.params.callId);
  });

  it("rejects with the main thread's code, name and raw answer", async () => {
    const { rpc } = mockRpc(() => ({ ok: false, error: { code: "BAD_JSON", message: "did not fit", raw: "{oops" } }));
    const error = await createPpmAi(rpc, "x").complete(request).catch((e) => e);
    expect(error).toBeInstanceOf(PpmAiError);
    expect([error.code, error.name, error.message, error.raw]).toEqual(["BAD_JSON", "PpmAiError", "did not fit", "{oops"]);
    const { rpc: aborted } = mockRpc(() => ({ ok: false, error: { code: "ABORTED", message: "x" } }));
    expect((await createPpmAi(aborted, "x").complete(request).catch((e) => e)).name).toBe("AbortError");
  });

  it("aborting the signal rejects at once and asks the main thread to cancel that call", async () => {
    let finish!: (v: unknown) => void;
    const { rpc, sent } = mockRpc((method) => (method === "ai:complete" ? new Promise((r) => { finish = r; }) : { cancelled: true }));
    const controller = new AbortController();
    const pending = createPpmAi(rpc, "probe-ext").complete(request, { signal: controller.signal }).catch((e) => e);
    await Promise.resolve();
    controller.abort();
    const error = await pending;
    expect([error.name, error.code]).toEqual(["AbortError", "ABORTED"]);
    const cancel = sent.find((s) => s.method === "ai:cancel")!;
    expect(cancel.params).toEqual({ extensionId: "probe-ext", callId: sent[0]!.params.callId });
    finish({ ok: true, result: {} }); // a late answer changes nothing
  });

  it("never calls the main thread for an already-aborted signal", async () => {
    const { rpc, sent } = mockRpc(() => ({ ok: true }));
    expect((await createPpmAi(rpc, "x").complete(request, { signal: AbortSignal.abort() }).catch((e) => e)).name).toBe("AbortError");
    expect(sent).toHaveLength(0);
  });

  it("turns its own RPC timeout into a TimeoutError and cancels the call", async () => {
    const { rpc, sent } = mockRpc((method) => {
      if (method === "ai:complete") throw new Error("RPC timeout: ai:complete (255000ms)");
      return { cancelled: true };
    });
    const error = await createPpmAi(rpc, "x").complete(request).catch((e) => e);
    expect([error.name, error.code]).toEqual(["TimeoutError", "TIMEOUT"]);
    expect(sent.map((s) => s.method)).toEqual(["ai:complete", "ai:cancel"]);
  });

  it("lists models with a longer RPC wait than the default", async () => {
    const { rpc, sent } = mockRpc(() => ({ claude: ["claude-haiku-4-5"], codex: [] }));
    expect(await createPpmAi(rpc, "x").listModels()).toEqual({ claude: ["claude-haiku-4-5"], codex: [] });
    expect(sent[0]).toMatchObject({ method: "ai:listModels", timeoutMs: 30_000 });
  });

  it("keeps the worker's limits equal to the main thread's", () => {
    expect([AI_MIN_TIMEOUT_MS, AI_MAX_TIMEOUT_MS, AI_DEFAULT_TIMEOUT_MS, AI_DEFAULT_WEB_TIMEOUT_MS])
      .toEqual([main.AI_MIN_TIMEOUT_MS, main.AI_MAX_TIMEOUT_MS, main.AI_DEFAULT_TIMEOUT_MS, main.AI_DEFAULT_WEB_TIMEOUT_MS]);
    expect(AI_MAX_QUEUE_WAIT_MS).toBe(mainLimiter.AI_MAX_QUEUE_WAIT_MS);
    expect(aiCompleteRpcTimeoutMs({})).toBe(180_000 + 75_000);
    expect(aiCompleteRpcTimeoutMs({ webSearch: true })).toBe(600_000 + 75_000);
    expect(aiCompleteRpcTimeoutMs({ timeoutMs: 10_000_000 })).toBe(900_000 + 75_000);
  });
});
