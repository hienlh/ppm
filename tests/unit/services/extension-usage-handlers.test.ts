import { describe, expect, test } from "bun:test";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerExtensionUsageHandlers, type ExtensionUsageDeps } from "../../../src/services/extension-api/extension-usage-handlers.ts";
import type { UsageAccountSource } from "../../../src/services/extension-api/extension-usage-summary.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

function channel(deps: ExtensionUsageDeps) {
  const posted: RpcMessage[] = [];
  const rpc = new RpcChannel((msg) => posted.push(msg), { debug() {}, warn() {}, error() {} });
  registerExtensionUsageHandlers(rpc, deps);
  let id = 0;
  const call = (method: string) => {
    const msgId = ++id;
    return rpc.handleMessage({ type: "request", id: msgId, method, params: [] })
      .then(() => (posted.find((m) => m.type === "response" && m.id === msgId) as RpcResponse).result as any);
  };
  return { call };
}

describe("usage:get / presence:get", () => {
  test("usage:get mixes Claude and Codex accounts and shapes them through the mapper", async () => {
    const claude: UsageAccountSource[] = [{ provider: "claude", accountId: "c1", status: "active", usage: {} }];
    const codex: UsageAccountSource[] = [{ provider: "codex", accountId: "x1", status: "active", usage: {} }];
    const { call } = channel({
      claudeAccounts: () => claude,
      codexAccounts: async () => codex,
      presence: () => ({ lastInputAt: null, idleMs: null, active: false, activeWindowMs: 600_000 }),
    });
    const result = await call("usage:get");
    expect(result.accounts.map((a: any) => [a.provider, a.accountId, a.alias])).toEqual([
      ["claude", "c1", "Claude 1"],
      ["codex", "x1", "Codex 1"],
    ]);
  });

  test("usage:get never calls codexAccounts eagerly beyond what the deps object returns (no forced refresh)", async () => {
    let codexCalls = 0;
    const { call } = channel({
      claudeAccounts: () => [],
      codexAccounts: async () => { codexCalls++; return []; },
      presence: () => ({ lastInputAt: null, idleMs: null, active: false, activeWindowMs: 600_000 }),
    });
    await call("usage:get");
    await call("usage:get");
    expect(codexCalls).toBe(2); // once per call, never more
  });

  test("presence:get answers with exactly what the presence dep reports", async () => {
    const snapshot = { lastInputAt: "2026-10-23T00:00:00.000Z", idleMs: 1000, active: true, activeWindowMs: 600_000 };
    const { call } = channel({
      claudeAccounts: () => [],
      codexAccounts: async () => [],
      presence: () => snapshot,
    });
    expect(await call("presence:get")).toEqual(snapshot);
  });
});
