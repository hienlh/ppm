/**
 * `/api/ext-mcp` through the real handler, the real token store and bindings in the real
 * database; only the worker behind a toolset is a fake caller.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { deleteExtension, insertExtensionSessionBinding } from "../../../src/services/db.service.ts";
import { bindSession, boundToolsetsFor, unbindSession } from "../../../src/services/extension-session-binding.service.ts";
import { createExtensionMcpHandler } from "../../../src/services/extension-mcp/extension-mcp-endpoint.ts";
import { ExtensionMcpRegistry, type ExtensionToolInvoker } from "../../../src/services/extension-mcp/extension-mcp-registry.ts";
import { createExtensionMcpTokenStore } from "../../../src/services/extension-mcp/extension-mcp-tokens.ts";
import { EXTENSION_TOOLSET_STARTING, type ExtensionMcpToolDefinition } from "../../../src/shared/extension-mcp.ts";

let run = 0;
const schema = { type: "object", properties: {} };
const toolset = (id: string, names: string[]) => ({ id, title: id, tools: names.map((name) => ({ name, description: name, inputSchema: schema })) });

function setup() {
  run++;
  const ext = `ext-mcp-endpoint-${process.pid}-${run}`;
  const saved = new Map<string, ExtensionMcpToolDefinition[]>();
  const registry = new ExtensionMcpRegistry({
    load: (e, id) => saved.get(`${e}:${id}`) ?? null,
    save: (e, ts) => { saved.set(`${e}:${ts.id}`, ts.tools); },
  });
  const tokens = createExtensionMcpTokenStore();
  const origins = new Map<string, string>();
  const app = new Hono();
  app.all("/api/ext-mcp", createExtensionMcpHandler({
    resolveToken: (t) => tokens.resolve(t), registry, boundToolsets: boundToolsetsFor,
    turnOrigin: async (sessionId) => origins.get(sessionId) ?? "unknown",
  }));
  const session = (toolsets: string[], extensionId = ext) => {
    const sessionId = `${ext}-s${Math.random().toString(36).slice(2, 8)}`;
    insertExtensionSessionBinding(sessionId, ext);
    bindSession(sessionId, ext, { toolsets });
    return { sessionId, token: tokens.mint({ sessionId, extensionId }) };
  };
  const post = (token: string, body: unknown, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}) =>
    app.request("http://localhost/api/ext-mcp", {
      method: "POST", signal: init.signal, body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
    });
  const list = async (token: string) =>
    ((await (await post(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).result.tools as { name: string }[]).map((t) => t.name);
  const call = async (token: string, name: string, args: unknown = {}, signal?: AbortSignal) => {
    const res = await post(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, { signal });
    expect(res.status).toBe(200);
    return (await res.json()) as { result?: { content: { text: string }[]; isError?: true }; error?: { code: number } };
  };
  return { ext, registry, tokens, origins, session, post, list, call };
}

const echo: ExtensionToolInvoker = async (name, args, ctx) => ({ text: `${name}:${JSON.stringify(args)}:${ctx.turnOrigin}` });

describe("extension MCP endpoint", () => {
  it("requires the session token, refuses browsers and bodies over 64 KB", async () => {
    const { session, post } = setup();
    const { token } = session(["fg"]);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post("wrong", ping)).status).toBe(401);
    expect((await post(token, ping, { headers: { Origin: "http://localhost:8080" } })).status).toBe(403);
    expect((await post(token, JSON.stringify({ ...ping, pad: "x".repeat(70_000) }))).status).toBe(413);
    const init = await (await post(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
    expect(init.result.serverInfo.name).toBe("ppm-ext");
  });

  it("shows each session only its own toolsets and runs the handler with the turn's origin", async () => {
    const { ext, registry, origins, session, list, call } = setup();
    registry.register(ext, toolset("fg", ["overview", "expand_node"]), echo);
    registry.register(ext, toolset("ab", ["status"]), echo);
    const a = session(["fg"]);
    const b = session(["ab"]);
    expect(await list(a.token)).toEqual(["fg_overview", "fg_expand_node"]);
    expect(await list(b.token)).toEqual(["ab_status"]);
    origins.set(a.sessionId, "extension");
    expect((await call(a.token, "fg_overview", { depth: 2 })).result).toEqual({ content: [{ type: "text", text: 'overview:{"depth":2}:extension' }] });
    expect((await call(b.token, "fg_overview")).result).toEqual({
      content: [{ type: "text", text: 'This chat is no longer bound to the toolset "fg".' }], isError: true,
    });
    expect((await call(b.token, "ab_nothing")).error?.code).toBe(-32602);
  });

  it("serves only the toolsets of the extension that owns the binding", async () => {
    const { ext, registry, session, list, call } = setup();
    registry.register(ext, toolset("fg", ["overview"]), echo);
    registry.register("someone-else", toolset("fg", ["overview"]), async () => ({ text: "not mine" }));
    const own = session(["fg"]);
    expect((await call(own.token, "fg_overview")).result?.content[0]!.text).toBe("overview:{}:unknown");
    const forged = session(["fg"], "someone-else");
    expect(await list(forged.token)).toEqual([]);
    expect((await call(forged.token, "fg_overview")).result).toEqual({
      content: [{ type: "text", text: "This chat is no longer bound to the extension that provides this tool." }], isError: true,
    });
  });

  it("lists last-known tools before the extension is back and serves them once it registers, without a new token", async () => {
    const { ext, registry, session, list, call } = setup();
    const { token } = session(["fg"]);
    expect(await list(token)).toEqual([]);
    registry.register(ext, toolset("fg", ["overview"]), echo);
    expect(await list(token)).toEqual(["fg_overview"]);
    registry.unregisterExtension(ext);
    expect(await list(token)).toEqual(["fg_overview"]);
    expect((await call(token, "fg_overview")).result).toEqual({ content: [{ type: "text", text: EXTENSION_TOOLSET_STARTING }], isError: true });
    registry.register(ext, toolset("fg", ["overview"]), echo);
    expect((await call(token, "fg_overview")).result?.isError).toBeUndefined();
  });

  it("answers an error result, never an error response, once the chat is unbound or its extension removed", async () => {
    const { ext, registry, session, list, call } = setup();
    registry.register(ext, toolset("fg", ["overview"]), echo);
    registry.register(ext, toolset("ab", ["status"]), echo);
    const a = session(["fg", "ab"]);
    bindSession(a.sessionId, ext, { toolsets: ["ab"] });
    expect(await list(a.token)).toEqual(["ab_status"]);
    expect((await call(a.token, "fg_overview")).result?.content[0]!.text).toBe('This chat is no longer bound to the toolset "fg".');
    unbindSession(a.sessionId, ext);
    expect(await list(a.token)).toEqual([]);
    expect((await call(a.token, "ab_status")).result?.isError).toBe(true);
    const b = session(["fg"]);
    deleteExtension(ext);
    const closed = await call(b.token, "fg_overview");
    expect(closed.result).toEqual({ content: [{ type: "text", text: "The extension that provided this tool was removed, so the chat is closed." }], isError: true });
  });

  it("cuts an answer over 200 KB and passes the request's abort to the extension", async () => {
    const { ext, registry, session, call } = setup();
    const seen: AbortSignal[] = [];
    registry.register(ext, toolset("fg", ["big", "slow"]), async (name, _args, _ctx, signal) => {
      if (name === "big") return { text: "y".repeat(300_000) };
      seen.push(signal);
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { text: "stopped", isError: true };
    });
    const { token } = session(["fg"]);
    const big = (await call(token, "fg_big")).result!.content[0]!.text;
    expect(big.startsWith("y".repeat(1000))).toBe(true);
    expect(big).toContain("[Truncated: the tool returned 300000 bytes");
    const stop = new AbortController();
    const pending = call(token, "fg_slow", {}, stop.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    stop.abort();
    expect((await pending).result).toEqual({ content: [{ type: "text", text: "stopped" }], isError: true });
    expect(seen[0]!.aborted).toBe(true);
  });
});
