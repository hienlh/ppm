/**
 * A toolset registered through the vscode-compat wrapper on one RPC channel and called through
 * the main thread's registry on the other — the same two halves the extension host joins, with
 * the worker's `ext:mcp:call` routing reproduced on the worker channel.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { ExtensionCallRegistry } from "../../../src/services/extension-api/extension-call-registry.ts";
import { registerExtensionMcpHandlers } from "../../../src/services/extension-api/extension-mcp-handlers.ts";
import { ExtensionMcpRegistry } from "../../../src/services/extension-mcp/extension-mcp-registry.ts";
import { createPpmMcp, type PpmMcpToolHandler } from "../../../packages/vscode-compat/src/ppm/ppm-mcp.ts";
import type { RpcClient } from "../../../packages/vscode-compat/src/types.ts";

const EXT = "probe-ext";
/** Another installed extension in the same worker. */
const OTHER = "other-ext";
const GENERATION = 7;
const schema = { type: "object", properties: {} };
const toolset = (id = "fg") => ({ id, title: "Graph", tools: [{ name: "overview", description: "Overview", inputSchema: schema }] });
const ctx = { sessionId: "s1", turnOrigin: "extension" };

function setup(options: { callTimeoutMs?: number } = {}) {
  let main!: RpcChannel;
  const worker = new RpcChannel((m) => queueMicrotask(() => void main.handleMessage(m)));
  main = new RpcChannel((m) => queueMicrotask(() => void worker.handleMessage(m)));
  const calls = new ExtensionCallRegistry();
  const registry = new ExtensionMcpRegistry({ load: () => null, save: () => {}, isEnabled: () => true });
  registerExtensionMcpHandlers(main, { generation: GENERATION, beginCall: () => calls.begin(GENERATION) }, {
    registry, isKnownExtension: (id) => id === EXT || id === OTHER, ...options,
  });
  const client = (extensionId: string) => {
    const rpc: RpcClient = {
      request: (method, ...p) => worker.sendRequest(method, ...p),
      requestWithTimeout: (method, timeoutMs, ...p) => worker.sendRequestWithTimeout(method, timeoutMs, p),
      notify: () => {},
    };
    return createPpmMcp(rpc, extensionId);
  };
  const mcp = client(EXT);
  // The extension host's routing, by the extension id the main thread names.
  const hosts = new Map([[EXT, mcp.host]]);
  worker.onRequest("ext:mcp:call", (p) => hosts.get((p[0] as { extensionId: string }).extensionId)!.call(p[0]));
  worker.onRequest("ext:mcp:cancel", (p) => ({ cancelled: hosts.get(EXT)!.cancel((p[0] as { callId: string }).callId) }));
  return { registry, calls, mcp, client, worker, close: () => { main.dispose(); worker.dispose(); } };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("extension MCP over RPC", () => {
  it("registers a toolset and runs its handler with the tool's own name, arguments and context", async () => {
    const { registry, mcp } = setup();
    const seen: unknown[] = [];
    const handler: PpmMcpToolHandler = async (name, args, c) => {
      seen.push([name, args, c.sessionId, c.turnOrigin, c.signal.aborted]);
      return { text: "graph has 3 nodes" };
    };
    const registration = mcp.api.registerToolset(toolset(), handler);
    expect(await registration.registered).toEqual(["fg_overview"]);
    expect(registry.list().map((t) => t.key)).toEqual([`${EXT}:fg`]);
    expect(await registry.call(`${EXT}:fg`, "overview", { depth: 1 }, ctx)).toEqual({ text: "graph has 3 nodes" });
    expect(seen).toEqual([["overview", { depth: 1 }, "s1", "extension", false]]);
    registration.dispose();
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.list()).toEqual([]);
  });

  it("refuses an invalid toolset or an unknown extension, and says why to the extension", async () => {
    const { registry, mcp, client } = setup();
    const tooMany = { ...toolset("big"), tools: Array.from({ length: 41 }, (_, i) => ({ name: `t${i}`, description: "x", inputSchema: schema })) };
    await expect(mcp.api.registerToolset(tooMany, async () => ({ text: "" })).registered).rejects.toThrow(/1-40 tools/);
    // The local handler went with the refusal, so the same id can be registered again.
    expect(await mcp.api.registerToolset(toolset("big"), async () => ({ text: "" })).registered).toEqual(["big_overview"]);
    const stranger = client("not-installed").api.registerToolset(toolset("zz"), async () => ({ text: "" }));
    await expect(stranger.registered).rejects.toThrow(/installed, enabled extension/);
    expect(registry.list().map((t) => t.key)).toEqual([`${EXT}:big`]);
  });

  it("cancels the handler when the model's request goes away", async () => {
    const { registry, mcp } = setup();
    const aborted: boolean[] = [];
    await mcp.api.registerToolset(toolset(), (_name, _args, c) => new Promise((resolve) => {
      c.signal.addEventListener("abort", () => { aborted.push(true); resolve({ text: "late" }); }, { once: true });
    })).registered;
    const request = new AbortController();
    const pending = registry.call(`${EXT}:fg`, "overview", {}, ctx, request.signal);
    await new Promise((r) => setTimeout(r, 10));
    request.abort();
    expect(await pending).toEqual({ text: "The call was cancelled.", isError: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toEqual([true]);
  });

  it("ends a call when its worker generation ends", async () => {
    const { registry, calls, mcp, close } = setup();
    await mcp.api.registerToolset(toolset(), () => new Promise(() => {})).registered;
    const pending = registry.call(`${EXT}:fg`, "overview", {}, ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.count(GENERATION)).toBe(1);
    expect(calls.endGeneration(GENERATION)).toBe(1);
    expect(await pending).toEqual({ text: "The extension host restarted, so the call was cancelled. Try again.", isError: true });
    expect(calls.count(GENERATION)).toBe(0);
    // The worker never answers; disposing the channels drops the request it still holds.
    close();
  });

  it("lets no other code in the shared worker drop or replace a running toolset", async () => {
    const { registry, mcp, worker } = setup();
    await mcp.api.registerToolset(toolset(), async () => ({ text: "the real one" })).registered;
    // What any extension in the worker can post: the owner's id, but not its registration's handle.
    await expect(worker.sendRequest("mcp:unregisterToolset", { extensionId: EXT, toolsetId: "fg" })).rejects.toThrow(/handle/);
    expect(await worker.sendRequest("mcp:unregisterToolset", { extensionId: EXT, toolsetId: "fg", handle: "guessed" }))
      .toEqual({ unregistered: false });
    await expect(worker.sendRequest("mcp:registerToolset", { extensionId: EXT, toolset: { ...toolset(), title: "Forged" } }))
      .rejects.toThrow(/already registered/);
    expect(registry.list().map((t) => t.title)).toEqual(["Graph"]);
    expect(await registry.call(`${EXT}:fg`, "overview", {}, ctx)).toEqual({ text: "the real one" });
  });

  it("drops a toolset with its own registration's handle, which only that registration holds", async () => {
    const { registry, mcp, client } = setup();
    const own = mcp.api.registerToolset(toolset(), async () => ({ text: "mine" }));
    const other = client(OTHER).api.registerToolset(toolset(), async () => ({ text: "theirs" }));
    await Promise.all([own.registered, other.registered]);
    own.dispose();
    await tick();
    expect(registry.list().map((t) => t.key)).toEqual([`${OTHER}:fg`]);
  });

  it("takes no toolset from an extension whose host was closed: deactivated, or its activation failed or timed out", async () => {
    const { registry, mcp } = setup();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      mcp.host.dispose();
      const late = mcp.api.registerToolset(toolset(), async () => ({ text: "nobody routes here" }));
      await expect(late.registered).rejects.toThrow(/no longer accepts toolsets/);
      await tick();
    } finally {
      console.error = original;
    }
    expect(registry.list()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("stops the worker's handler when a call outlives its time limit", async () => {
    const { registry, calls, mcp } = setup({ callTimeoutMs: 50 });
    const aborted: string[] = [];
    await mcp.api.registerToolset(toolset(), (_name, _args, c) => new Promise(() => {
      // Never answers, as a hung handler would; only its signal can tell it to stop.
      c.signal.addEventListener("abort", () => aborted.push((c.signal.reason as Error).name), { once: true });
    })).registered;
    const result = await registry.call(`${EXT}:fg`, "overview", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/did not answer within/);
    await tick();
    expect(aborted).toEqual(["AbortError"]);
    expect(calls.count(GENERATION)).toBe(0);
  });
});
