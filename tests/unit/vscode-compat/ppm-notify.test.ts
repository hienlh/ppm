import { describe, expect, it } from "bun:test";
import { createPpmNotify, PpmNotifyError } from "../../../packages/vscode-compat/src/ppm/ppm-notify.ts";
import { createPpmNamespace } from "../../../packages/vscode-compat/src/ppm/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

const request = { title: "Node merged", body: "Two nodes converged on the same outcome." };

function mockRpc(answer: (method: string, params: any) => unknown) {
  const sent: { method: string; params: any }[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string, ...params: unknown[]) {
      sent.push({ method, params: params[0] });
      return answer(method, params[0]) as T;
    },
    async requestWithTimeout<T>(method: string, _timeoutMs: number, ...params: unknown[]) {
      sent.push({ method, params: params[0] });
      return answer(method, params[0]) as T;
    },
    notify() {},
  };
  return { rpc, sent };
}

describe("ppm.notify", () => {
  it("is the notify area of the ppm namespace", () => {
    expect(typeof createPpmNamespace(mockRpc(() => null).rpc, "probe").notify).toBe("function");
  });

  it("sends one notify:send carrying the extension id, and returns the outcome", async () => {
    const { rpc, sent } = mockRpc(() => ({ ok: true, result: "sent" }));
    const result = await createPpmNotify(rpc, "probe-ext")(request);
    expect(result).toBe("sent");
    expect(sent).toEqual([{ method: "notify:send", params: { ...request, extensionId: "probe-ext" } }]);
  });

  it("passes sessionId, projectName, providerId and path through untouched", async () => {
    const { rpc, sent } = mockRpc(() => ({ ok: true, result: "off" }));
    const full = { ...request, sessionId: "s1", projectName: "ppm", providerId: "codex", path: "/project/ppm/design/landing" };
    await createPpmNotify(rpc, "probe-ext")(full);
    expect(sent[0]!.params).toEqual({ ...full, extensionId: "probe-ext" });
  });

  it("rejects with the main thread's code, name and message", async () => {
    const { rpc } = mockRpc(() => ({ ok: false, error: { code: "RATE_LIMITED", message: "At most 30 notifications an hour per extension" } }));
    const error = await createPpmNotify(rpc, "probe-ext")(request).catch((e) => e);
    expect(error).toBeInstanceOf(PpmNotifyError);
    expect([error.code, error.name, error.message]).toEqual(["RATE_LIMITED", "PpmNotifyError", "At most 30 notifications an hour per extension"]);
  });
});
