/**
 * `/api/assistant-mcp` serves the PPM Assistant's tools to one Assistant session's agent. Its
 * token is the whole credential, so it must be refused from a browser, for any other session,
 * and once the session is gone — and still honoured after Codex renames the session on its
 * first turn. A tool call may outlast Bun's 10 s idle limit, so the endpoint lifts it.
 */
import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import {
  deleteSessionMetadata, setSessionAssistant, setSessionMetadata, setSessionMigratedTo,
} from "../../../src/services/db.service.ts";
import { createAssistantMcpHandler, isLiveAssistantSession } from "../../../src/services/assistant-mcp/assistant-mcp-endpoint.ts";
import { createAssistantMcpTokenStore } from "../../../src/services/assistant-mcp/assistant-mcp-tokens.ts";
import { ASSISTANT_MCP_HOLD_OPEN_SECONDS, ASSISTANT_MCP_TIMEOUT_MS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { ASSISTANT_TOOLS } from "../../../src/shared/assistant-tool-names.ts";
import { createMcpHttpHandler, textResult } from "../../../src/services/mcp-http-endpoint.ts";

const id = () => `s-${crypto.randomUUID()}`;

function setup() {
  const tokens = createAssistantMcpTokenStore();
  const calls: Array<{ sessionId: string; name: string; args: unknown }> = [];
  const handler = createAssistantMcpHandler({
    resolveToken: (t) => tokens.resolve(t),
    isAssistant: isLiveAssistantSession,
    callTool: async ({ sessionId }, name, args) => {
      calls.push({ sessionId, name, args });
      return textResult("done");
    },
  });
  const app = new Hono();
  app.all("/api/assistant-mcp", handler);
  const timeouts: number[] = [];
  const env = { timeout: (_req: Request, seconds: number) => { timeouts.push(seconds); } };
  const rpc = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request("http://localhost/api/assistant-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }), env);
  const call = (token: string, name = "projects_list", args: unknown = {}) =>
    rpc(token, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
  return { tokens, calls, rpc, call, timeouts };
}

function assistantSession(): string {
  const sessionId = id();
  setSessionMetadata(sessionId, "__assistant__", "/somewhere");
  setSessionAssistant(sessionId);
  return sessionId;
}

describe("assistant MCP endpoint", () => {
  it("lists its tools under the ppm-assistant server", async () => {
    const { tokens, rpc } = setup();
    const token = tokens.mint({ sessionId: assistantSession() });
    const init = await (await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
    expect(init.result.serverInfo.name).toBe("ppm-assistant");
    const list = await (await rpc(token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([...ASSISTANT_TOOLS]);
    // Every tool reads, except the ones that move the user's screen, which change no data, the
    // two that may change data once the user approves, and the one running PPM's commands, an
    // extension's among them, which may also reach outside.
    const navigation = new Set(["ui_open_tab", "ui_focus_tab", "ui_switch_project", "ui_close_tab"]);
    const writes = new Set(["db_query", "chat_send_message"]);
    for (const tool of list.result.tools) {
      if (navigation.has(tool.name)) expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      else if (writes.has(tool.name)) expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      else if (tool.name === "ui_run_command") expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      else expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("refuses a browser request, a wrong token and a body over the cap", async () => {
    const { tokens, rpc } = setup();
    const token = tokens.mint({ sessionId: assistantSession() });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(token, ping, { Origin: "http://localhost:8080" })).status).toBe(403);
    expect((await rpc("not-a-token", ping)).status).toBe(401);
    expect((await rpc(token, JSON.stringify({ ...ping, pad: "x".repeat(70 * 1024) }))).status).toBe(413);
    expect((await rpc(token, ping)).status).toBe(200);
  });

  it("refuses the token of a session that is not an Assistant session", async () => {
    const { tokens, call, calls } = setup();
    const ordinary = id();
    setSessionMetadata(ordinary, "proj", "/projects/proj");
    const res = await call(tokens.mint({ sessionId: ordinary }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("keeps honouring a Codex session's token after the first turn renames it, until it is deleted", async () => {
    const { tokens, call, calls } = setup();
    const draft = assistantSession();
    const token = tokens.mint({ sessionId: draft });
    const thread = id();
    setSessionMetadata(thread, "__assistant__", "/somewhere");
    setSessionMigratedTo(draft, thread);
    expect((await call(token)).status).toBe(200);
    expect(calls.map((c) => c.sessionId)).toEqual([draft]);
    // Deleting the renamed session leaves the draft's row (and its mark) behind.
    deleteSessionMetadata(thread);
    expect((await call(token)).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("refuses a token once its session's record is gone", async () => {
    const { tokens, call } = setup();
    const sessionId = assistantSession();
    const token = tokens.mint({ sessionId });
    deleteSessionMetadata(sessionId);
    expect((await call(token)).status).toBe(401);
  });

  it("lifts Bun's idle limit altogether before a tool call runs: an approval waits as long as the user takes", async () => {
    const { tokens, call, rpc, timeouts } = setup();
    const token = tokens.mint({ sessionId: assistantSession() });
    await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(timeouts).toEqual([]);
    const res = await call(token, "db_query", { connectionId: 1, sql: "SELECT 1" });
    expect((await res.json()).result.content[0].text).toBe("done");
    // 0 is Bun's "no idle limit" for the request.
    expect(timeouts).toEqual([0]);
    expect(ASSISTANT_MCP_HOLD_OPEN_SECONDS).toBe(0);
    // The providers' own timeout is the longest a timer holds, not a few minutes.
    expect(ASSISTANT_MCP_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });

  it("leaves the idle limit alone for an endpoint that does not ask", async () => {
    const handler = createMcpHttpHandler({
      serverName: "plain", tokenRequired: "token", resolveToken: () => ({ sessionId: "s" }),
      tools: [{ name: "t", inputSchema: { type: "object" } }], callTool: async () => textResult("ok"),
    });
    const app = new Hono();
    app.all("/mcp", handler);
    const timeouts: number[] = [];
    await app.fetch(new Request("http://localhost/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t", arguments: {} } }),
    }), { timeout: (_r: Request, s: number) => { timeouts.push(s); } });
    expect(timeouts).toEqual([]);
  });
});
