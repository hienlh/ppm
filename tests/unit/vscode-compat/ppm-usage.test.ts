import { describe, expect, it } from "bun:test";
import { createPpmUsage, createPpmPresence } from "../../../packages/vscode-compat/src/ppm/ppm-usage.ts";
import { createPpmNamespace } from "../../../packages/vscode-compat/src/ppm/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

function mockRpc(answer: (method: string) => unknown) {
  const sent: string[] = [];
  const rpc: RpcClient = {
    async request<T>(method: string) {
      sent.push(method);
      return answer(method) as T;
    },
    async requestWithTimeout<T>(method: string) {
      sent.push(method);
      return answer(method) as T;
    },
    notify() {},
  };
  return { rpc, sent };
}

describe("ppm.usage", () => {
  it("is the usage area of the ppm namespace, exposed alongside presence", () => {
    const ns = createPpmNamespace(mockRpc(() => null).rpc, "probe");
    expect(typeof ns.usage.get).toBe("function");
    expect(typeof ns.presence.get).toBe("function");
  });

  it("get() is one plain usage:get RPC with no extension id or params", async () => {
    const summary = { now: "2026-10-23T00:00:00.000Z", accounts: [] };
    const { rpc, sent } = mockRpc(() => summary);
    expect(await createPpmUsage(rpc).get()).toEqual(summary);
    expect(sent).toEqual(["usage:get"]);
  });

  it("carries a Claude and a Codex account through untouched", async () => {
    const summary = {
      now: "2026-10-23T00:00:00.000Z",
      accounts: [
        {
          provider: "claude", accountId: "c1", alias: "Claude 1", status: "active",
          fiveHour: { usedPct: 42, resetsAt: "2026-10-23T01:00:00.000Z", resetsInMs: 3_600_000 },
          fetchedAt: "2026-10-23T00:00:00.000Z", ageMs: 0,
        },
        { provider: "codex", accountId: "x1", alias: "Codex 1", status: "disabled", fetchedAt: null, ageMs: null },
      ],
    };
    const { rpc } = mockRpc(() => summary);
    expect(await createPpmUsage(rpc).get()).toEqual(summary as any);
  });
});

describe("ppm.presence", () => {
  it("get() is one plain presence:get RPC", async () => {
    const snapshot = { lastInputAt: null, idleMs: null, active: false, activeWindowMs: 600_000 };
    const { rpc, sent } = mockRpc(() => snapshot);
    expect(await createPpmPresence(rpc).get()).toEqual(snapshot);
    expect(sent).toEqual(["presence:get"]);
  });

  it("carries an active reading through untouched", async () => {
    const snapshot = { lastInputAt: "2026-10-23T00:09:00.000Z", idleMs: 540_000, active: true, activeWindowMs: 600_000 };
    const { rpc } = mockRpc(() => snapshot);
    expect(await createPpmPresence(rpc).get()).toEqual(snapshot);
  });
});
