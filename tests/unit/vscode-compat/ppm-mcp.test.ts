import { describe, expect, it } from "bun:test";
import { createPpmMcp } from "../../../packages/vscode-compat/src/ppm/ppm-mcp.ts";
import { createPpmNamespace } from "../../../packages/vscode-compat/src/ppm/index.ts";
import { createVscodeCompat } from "../../../packages/vscode-compat/src/index.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

const schema = { type: "object", properties: {} };
const toolset = { id: "fg", title: "Graph", tools: [{ name: "overview", description: "Overview", inputSchema: schema }] };

function mockRpc(answer: (method: string, params: any) => unknown = () => ({ tools: ["fg_overview"], handle: "h-1" })) {
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

const call = (toolsetId: string, extra: Record<string, unknown> = {}) =>
  ({ extensionId: "probe-ext", toolsetId, name: "overview", args: { a: 1 }, ctx: { sessionId: "s1", turnOrigin: "ws" }, callId: "c1", ...extra });

describe("ppm.mcp", () => {
  it("is the mcp area of the ppm namespace, and the extension host gets its routing half", () => {
    const { rpc } = mockRpc();
    expect(typeof createPpmNamespace(rpc, "probe").mcp.registerToolset).toBe("function");
    const api = createVscodeCompat({ extensionId: "probe", extensionPath: "/x", storagePath: "/x/.storage", rpc });
    expect(typeof api.ppm.mcp.registerToolset).toBe("function");
    expect(typeof api._mcpHost.call).toBe("function");
  });

  it("registers under its own extension id and routes a call to the handler", async () => {
    const { rpc, sent } = mockRpc();
    const { api, host } = createPpmMcp(rpc, "probe-ext");
    const registration = api.registerToolset(toolset, async (name, args, ctx) => ({ text: `${name} ${JSON.stringify(args)} ${ctx.turnOrigin}` }));
    expect(await registration.registered).toEqual(["fg_overview"]);
    expect(sent[0]).toEqual({ method: "mcp:registerToolset", params: { extensionId: "probe-ext", toolset } });
    expect(await host.call(call("fg"))).toEqual({ text: 'overview {"a":1} ws' });
    expect(() => api.registerToolset(toolset, async () => ({ text: "" }))).toThrow(/already registered/);
    registration.dispose();
    registration.dispose();
    await new Promise((r) => setTimeout(r, 0));
    // The handle the main thread returned is what drops it; nothing else in the worker holds it.
    expect(sent.filter((m) => m.method === "mcp:unregisterToolset")).toEqual([
      { method: "mcp:unregisterToolset", params: { extensionId: "probe-ext", toolsetId: "fg", handle: "h-1" } },
    ]);
    expect((await host.call(call("fg"))).isError).toBe(true);
  });

  it("sends the dispose of a registration still in flight once its handle arrives", async () => {
    let answer!: (value: unknown) => void;
    const { rpc, sent } = mockRpc((method) => method === "mcp:registerToolset" ? new Promise((r) => { answer = r; }) : {});
    const { api } = createPpmMcp(rpc, "probe-ext");
    const registration = api.registerToolset(toolset, async () => ({ text: "" }));
    registration.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((m) => m.method)).toEqual(["mcp:registerToolset"]);
    answer({ tools: ["fg_overview"], handle: "h-2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[1]).toEqual({ method: "mcp:unregisterToolset", params: { extensionId: "probe-ext", toolsetId: "fg", handle: "h-2" } });
  });

  it("refuses new toolsets once the host is closed, without asking the main thread", async () => {
    const { rpc, sent } = mockRpc();
    const { api, host } = createPpmMcp(rpc, "probe-ext");
    host.dispose();
    const original = console.error;
    console.error = () => {};
    try {
      const late = api.registerToolset(toolset, async () => ({ text: "" }));
      await expect(late.registered).rejects.toThrow(/no longer accepts toolsets/);
      late.dispose();
    } finally {
      console.error = original;
    }
    expect(sent).toEqual([]);
  });

  it("frees a cancelled call at once, even when its handler never notices", async () => {
    const { api, host } = createPpmMcp(mockRpc().rpc, "probe-ext");
    api.registerToolset(toolset, () => new Promise(() => {}));
    void host.call(call("fg", { callId: "hung" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(host.cancel("hung")).toBe(true);
    expect(host.cancel("hung")).toBe(false);
  });

  it("answers an error result for an unknown toolset, a throwing handler or a non-text answer", async () => {
    const { api, host } = createPpmMcp(mockRpc().rpc, "probe-ext");
    api.registerToolset(toolset, async () => { throw new Error("db locked"); });
    api.registerToolset({ ...toolset, id: "ab" }, async () => ({ nope: true }) as never);
    expect(await host.call(call("zz"))).toEqual({ text: 'The extension has no toolset "zz" running.', isError: true });
    expect(await host.call(call("fg"))).toEqual({ text: "The tool failed: db locked", isError: true });
    expect(await host.call(call("ab"))).toEqual({ text: "The tool returned no text.", isError: true });
  });

  it("aborts the handler's signal on cancel and on dispose", async () => {
    const { api, host } = createPpmMcp(mockRpc().rpc, "probe-ext");
    const reasons: string[] = [];
    api.registerToolset(toolset, (_n, _a, ctx) => new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => { reasons.push((ctx.signal.reason as Error).name); resolve({ text: "stopped" }); });
    }));
    const first = host.call(call("fg", { callId: "c1" }));
    expect(host.cancel("c1")).toBe(true);
    expect(await first).toEqual({ text: "stopped" });
    expect(host.cancel("c1")).toBe(false);
    const second = host.call(call("fg", { callId: "c2" }));
    host.dispose();
    expect(await second).toEqual({ text: "stopped" });
    expect(reasons).toEqual(["AbortError", "AbortError"]);
  });

  it("forgets a toolset the main thread refused, so the id can be registered again", async () => {
    const { api } = createPpmMcp(mockRpc(() => { throw new Error("refused"); }).rpc, "probe-ext");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await expect(api.registerToolset(toolset, async () => ({ text: "" })).registered).rejects.toThrow("refused");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(() => api.registerToolset(toolset, async () => ({ text: "" }))).not.toThrow();
  });
});
