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
import { callAssistantTool, createAssistantMcpHandler, isLiveAssistantSession } from "../../../src/services/assistant-mcp/assistant-mcp-endpoint.ts";
import { createAssistantMcpTokenStore } from "../../../src/services/assistant-mcp/assistant-mcp-tokens.ts";
import { ASSISTANT_MCP_HOLD_OPEN_SECONDS, ASSISTANT_MCP_TIMEOUT_MS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import { ASSISTANT_TOOLS } from "../../../src/shared/assistant-tool-names.ts";
import { GIT_TOOLS } from "../../../src/shared/assistant-git-tool-names.ts";
import { SCHEDULE_TOOLS } from "../../../src/shared/assistant-schedule-tool-names.ts";
import { TUNNEL_TOOLS } from "../../../src/shared/assistant-tunnel-tool-names.ts";
import { PROJECT_TOOLS } from "../../../src/shared/assistant-project-tool-names.ts";
import { CHAT_TOOLS } from "../../../src/shared/assistant-chat-tool-names.ts";
import { DB_CONNECTION_TOOLS } from "../../../src/shared/assistant-db-connection-tool-names.ts";
import { createMcpHttpHandler, textResult } from "../../../src/services/mcp-http-endpoint.ts";
import { assistantTurnProvenance } from "../../../src/services/assistant/assistant-turn-provenance.ts";

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
    // ones that may change data once the user approves, and the one running PPM's commands, an
    // extension's among them, which may also reach outside.
    // Setting and stopping a watch changes only PPM's own record of what to report, like navigation.
    // So do the notebook's add and edit; deleting a line is the one change there that loses text.
    // Adding a project asks first but takes nothing away, so it is not destructive either.
    // Typing a line into a new terminal runs nothing until the user presses Enter, so it takes nothing away.
    const navigation = new Set(["ui_open_tab", "ui_focus_tab", "ui_switch_project", "ui_close_tab", "ui_move_tab", "chat_watch", "chat_unwatch", "notebook_add", "notebook_edit", "project_add", "terminal_type"]);
    const writes = new Set(["db_query", "chat_answer_approval", "notebook_delete"]);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["chats_attention", "chat_answer_approval", "ppm_cli_reference", "chat_changes", "chat_changes_answer"]));
    // Opening and messaging chats is the session tools' job, never this server's.
    expect(names).not.toContain("chat_send_message");
    expect(names).not.toContain("chat_start");
    // The git, schedule, tunnel, project, chat and connection families annotate their own tools, checked beside each family.
    const familyTools = new Set<string>([...GIT_TOOLS, ...SCHEDULE_TOOLS, ...TUNNEL_TOOLS, ...PROJECT_TOOLS, ...CHAT_TOOLS, ...DB_CONNECTION_TOOLS]);
    expect(names.slice(-(PROJECT_TOOLS.length + CHAT_TOOLS.length + DB_CONNECTION_TOOLS.length + 1)))
      .toEqual([...PROJECT_TOOLS, ...CHAT_TOOLS, ...DB_CONNECTION_TOOLS, "terminal_type"]);
    // History changes and branch deletion can lose work, so both say so.
    const annotations = (name: string) => list.result.tools.find((t: { name: string }) => t.name === name)?.annotations;
    for (const name of ["git_history", "git_branch"]) {
      expect({ name, annotations: annotations(name) }).toEqual({ name, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } });
    }
    // Saving a connection takes nothing away; deleting one does; a test only reads, but dials out.
    expect(annotations("db_connection_save")).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(annotations("db_connection_delete")).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(annotations("db_connection_test")).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(annotations("terminal_type")).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    for (const tool of list.result.tools) {
      if (familyTools.has(tool.name)) continue;
      if (navigation.has(tool.name)) expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
      else if (writes.has(tool.name)) expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      else if (tool.name === "ui_run_command") expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
      else expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("routes the chat-management tools to their handlers", async () => {
    const sessionId = assistantSession();
    const reference = await callAssistantTool({ sessionId }, "ppm_cli_reference", {}) as { content: Array<{ text: string }> };
    expect(reference.content[0]!.text).toContain("## Command groups");
    const configGroup = await callAssistantTool({ sessionId }, "ppm_cli_reference", { group: "config" }) as { content: Array<{ text: string }> };
    expect(configGroup.content[0]!.text).toContain("ppm config set <key> <value>");
    const overview = await callAssistantTool({ sessionId }, "chats_attention", { since: "6h" }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(overview.isError).toBeFalsy();
    expect(JSON.parse(overview.content[0]!.text)).toMatchObject({ needsDecision: [], running: [] });
    const refused = await callAssistantTool({ sessionId }, "chats_attention", { since: "last week" }) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    // The watch tools reach the watch service, which says when this process does not run it.
    const watches = await callAssistantTool({ sessionId }, "chat_list_watches", {}) as { content: Array<{ text: string }>; isError?: boolean };
    expect(watches.isError).toBe(true);
    expect(watches.content[0]!.text).toContain("not available");
  });

  it("marks the turn untrusted for every tool but the few that answer with PPM's or the user's own data", async () => {
    const opened = (sessionId: string) => assistantTurnProvenance.noteMessage({ sessionId, text: "tell the manager", origin: "ws" });
    const clean = assistantSession();
    opened(clean);
    // Typing into a terminal answers with PPM's own words, never what the shell printed.
    for (const name of ["projects_list", "ppm_cli_reference", "terminal_type"]) await callAssistantTool({ sessionId: clean }, name, {});
    expect(assistantTurnProvenance.provenance(clean).untrusted).toBe(false);
    // Chat titles, tab titles, a git family read and a chat's file changes all carry text the user did not write.
    for (const name of ["chat_list_sessions", "ui_get_state", GIT_TOOLS[0]!, "chat_changes"]) {
      const sessionId = assistantSession();
      opened(sessionId);
      await callAssistantTool({ sessionId }, name, {}).catch(() => null);
      expect({ name, untrusted: assistantTurnProvenance.provenance(sessionId).untrusted }).toEqual({ name, untrusted: true });
    }
  });

  it("hands a family tool the turn's provenance as it stood before the call itself marked the turn", async () => {
    const sessionId = assistantSession();
    assistantTurnProvenance.noteMessage({ sessionId, text: "tidy my chats", origin: "ws" });
    const original = assistantTurnProvenance.provenance;
    const seen: Array<ReturnType<typeof original>> = [];
    assistantTurnProvenance.provenance = (id: string) => {
      const p = original(id);
      seen.push(p);
      return p;
    };
    try {
      await callAssistantTool({ sessionId }, "chat_organize", { project: "no-such-project", changes: [{ sessionId: "abc", read: true }] });
    } finally {
      assistantTurnProvenance.provenance = original;
    }
    expect(seen[0]).toMatchObject({ startedBy: "user_ppm", untrusted: false });
    // The call itself still counts: chat titles may come back from it.
    expect(assistantTurnProvenance.provenance(sessionId).untrusted).toBe(true);
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
