import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createDesignMcpHandler } from "../../../src/services/design/mcp/design-mcp-endpoint.ts";
import { createDesignMcpTokenStore } from "../../../src/services/design/mcp/design-mcp-tokens.ts";
import type { CanvasCheckOutcome } from "../../../src/services/design/check/design-canvas-check-broker.ts";

function setup(outcome: CanvasCheckOutcome = { ok: false, error: "no canvas" }) {
  const tokens = createDesignMcpTokenStore();
  const calls: Array<{ projectPath: string; slug: string; screenshot: boolean }> = [];
  const handler = createDesignMcpHandler({
    resolveToken: (t) => tokens.resolve(t),
    check: async (projectPath, slug, { screenshot }) => { calls.push({ projectPath, slug, screenshot }); return outcome; },
  });
  const app = new Hono();
  app.all("/api/design-mcp", handler);
  const token = tokens.mint({ sessionId: "s1", projectPath: "/proj", slug: "home" });
  const rpc = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) =>
    app.request("http://localhost/api/design-mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { tokens, token, calls, rpc, app };
}

describe("design MCP endpoint", () => {
  it("requires the session token and refuses browser requests", async () => {
    const { rpc, token } = setup();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(ping, {})).status).toBe(401);
    expect((await rpc(ping, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await rpc(ping, { Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status).toBe(403);
    expect((await rpc(ping)).status).toBe(200);
  });

  it("initializes, lists only design_check, and accepts notifications", async () => {
    const { rpc } = setup();
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ppm-design" } });
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["design_check"]);
    const unknown = await (await rpc({ jsonrpc: "2.0", id: 3, method: "resources/list" })).json();
    expect(unknown.error.code).toBe(-32601);
  });

  it("checks the design the token was minted for and returns text plus the screenshot", async () => {
    const report = {
      viewport: { width: 800, height: 600 }, page: { width: 800, height: 600 },
      findings: [{ kind: "implicit-grid" as const, message: "pushed" }], counts: { "implicit-grid": 1 },
      file: "index.html", gen: null, frame: "Desktop", screenshot: { dataUrl: "data:image/jpeg;base64,QUJD", width: 2, height: 2 },
    };
    const { rpc, calls } = setup({ ok: true, report });
    const res = await (await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "design_check", arguments: {} } })).json();
    expect(calls).toEqual([{ projectPath: "/proj", slug: "home", screenshot: true }]);
    expect(res.id).toBe(7);
    expect(res.result.content[0].type).toBe("text");
    expect(res.result.content[0].text).toContain("[implicit-grid] pushed");
    expect(res.result.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
    expect(res.result.isError).toBeUndefined();
  });

  it("reports a missing canvas as a tool error and refuses other tools", async () => {
    const { rpc, calls } = setup();
    const res = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "design_check", arguments: { screenshot: false } } })).json();
    expect(res.result).toEqual({ content: [{ type: "text", text: "no canvas" }], isError: true });
    expect(calls[0]!.screenshot).toBe(false);
    const other = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "Bash" } })).json();
    expect(other.error.code).toBe(-32602);
  });

  it("rejects batches, malformed JSON and non-POST methods", async () => {
    const { rpc, app, token } = setup();
    expect((await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
    const bad = await app.request("http://localhost/api/design-mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{" });
    expect(bad.status).toBe(400);
    const get = await app.request("http://localhost/api/design-mcp", { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });
});

describe("design MCP tokens", () => {
  it("reuses a session's token while its binding holds, and replaces it when the design changes", () => {
    const tokens = createDesignMcpTokenStore();
    const a = tokens.mint({ sessionId: "s", projectPath: "/p", slug: "home" });
    expect(tokens.mint({ sessionId: "s", projectPath: "/p", slug: "home" })).toBe(a);
    const b = tokens.mint({ sessionId: "s", projectPath: "/p", slug: "other" });
    expect(b).not.toBe(a);
    expect(tokens.resolve(a)).toBeNull();
    expect(tokens.resolve(b)).toEqual({ sessionId: "s", projectPath: "/p", slug: "other" });
  });

  it("revokes and evicts the least recently used", () => {
    const tokens = createDesignMcpTokenStore(2);
    const one = tokens.mint({ sessionId: "1", projectPath: "/p", slug: "a" });
    const two = tokens.mint({ sessionId: "2", projectPath: "/p", slug: "a" });
    tokens.mint({ sessionId: "1", projectPath: "/p", slug: "a" });
    tokens.mint({ sessionId: "3", projectPath: "/p", slug: "a" });
    expect(tokens.resolve(two)).toBeNull();
    expect(tokens.resolve(one)).not.toBeNull();
    tokens.revoke("1");
    expect(tokens.resolve(one)).toBeNull();
    expect(tokens.resolve("")).toBeNull();
    expect(tokens.resolve(null)).toBeNull();
  });
});
