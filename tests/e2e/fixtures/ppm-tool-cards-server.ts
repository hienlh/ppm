/**
 * Served-production fixture for the cards of PPM's own tools (tasks, session history, schedules,
 * reports, db_query). Adapted from tab-tools-server. Requires an isolated home and PPM directory,
 * serves the scratch Vite bundle named by PPM_TOOL_CARDS_WEB_DIR, and answers every turn with a
 * scripted provider that streams the tool calls the e2e posts — each with the output the real tool
 * writes, an error, or no answer until the e2e releases it (a call still running). No real SDK,
 * CLI or MCP endpoint: only what the chat shows is under test here.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false, tab_tools: true,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
});
// Answer the tour's "new features" question up front, or its step covers what the e2e clicks.
const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
for (const intro of FEATURE_INTROS) answerFeatureIntro(intro.id, "on");

const { MockProvider } = await import("../../../src/providers/mock-provider");
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;

/**
 * One scripted call: the tool's full name and input, and what it answers — `real` calls PPM's own
 * endpoint for that server with the token the turn was handed, as the Claude CLI does; otherwise
 * `output` is the answer (none at all while `hold`).
 */
type ScriptOp = { tool: string; input: Record<string, unknown>; output?: string; isError?: boolean; hold?: boolean; real?: boolean };
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
const { stringifyToolResultContent } = await import("../../../src/shared/tool-result-content");

/** The answer PPM's endpoint gives a real call, as the Claude provider hands it to the chat. */
async function callReal(op: ScriptOp, opts: SendOpts | undefined): Promise<{ output: string; isError: boolean }> {
  const m = /^mcp__(ppm-sessions|ppm-tabs)__(.+)$/.exec(op.tool);
  const access = m?.[1] === "ppm-sessions" ? opts?.sessionCollabMcp : m?.[1] === "ppm-tabs" ? opts?.tabToolsMcp : undefined;
  if (!m || !access) return { output: `fixture: this turn was not handed that server (it got: ${Object.keys(opts ?? {}).join(", ")})`, isError: true };
  const response = await fetch(access.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: m[2], arguments: op.input } }),
  });
  const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
  return { output: stringifyToolResultContent((body?.result?.content ?? []) as never), isError: body?.result?.isError === true };
}
const realAnswers: Array<{ tool: string; output: string; isError: boolean }> = [];

let script: ScriptOp[] = [];
let turnCount = 0;
let release: (() => void) | null = null;
let holding = false;

class ToolCardsMock extends MockProvider {
  private history = new Map<string, ChatMessage[]>();
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  /** What "Set as manager chat" asks to find the chat: the mock keeps its sessions in memory. */
  async getSessionInfoById(sessionId: string) {
    return (await this.listSessions()).find((s) => s.id === sessionId) ?? null;
  }
  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
  override async *sendMessage(sessionId: string, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    yield { type: "system" as never, subtype: "init" } as never;
    const events: ChatEvent[] = [];
    const ops = script;
    script = [];
    for (const op of ops) {
      const toolUseId = `tu-${crypto.randomUUID()}`;
      const use = { type: "tool_use", tool: op.tool, input: op.input, toolUseId } as ChatEvent;
      events.push(use);
      yield use;
      if (op.hold) {
        holding = true;
        await new Promise<void>((done) => { release = done; });
        holding = false;
      }
      const answer = op.real ? await callReal(op, opts) : op.output === undefined ? null : { output: op.output, isError: op.isError === true };
      if (op.real && answer) realAnswers.push({ tool: op.tool, ...answer });
      if (!answer) continue;
      const result = { type: "tool_result", output: answer.output, isError: answer.isError, toolUseId } as ChatEvent;
      events.push(result);
      yield result;
    }
    // Numbered, so the e2e can tell when this turn's answer is on screen.
    const text = `Turn ${++turnCount}: done.`;
    yield { type: "text", content: text };
    history.push({ id: crypto.randomUUID(), role: "assistant", content: text, events, timestamp: new Date().toISOString() } as ChatMessage);
    this.history.set(sessionId, history);
    yield { type: "done", sessionId };
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ToolCardsMock();
const providers = [claude];
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__cards-test/script" && req.method === "POST") {
    script = (await req.json() as { ops: ScriptOp[] }).ops;
    return json({ ok: true, ops: script.length });
  }
  if (path === "/__cards-test/holding") return json({ holding, turns: turnCount });
  if (path === "/__cards-test/real") return json({ answers: realAnswers });
  if (path === "/__cards-test/release" && req.method === "POST") {
    const was = !!release;
    release?.();
    release = null;
    return json({ released: was });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__cards-test/")) return testRoute(req, url.pathname);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_TOOL_CARDS_WEB_DIR;
      if (!webDir) throw new Error("PPM_TOOL_CARDS_WEB_DIR required");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960, sendPong: true,
    open(ws) {
      if (ws.data.type === "chat") chatWebSocket.open(ws as never);
      else if (ws.data.type === "global") globalWebSocket.open(ws);
    },
    message(ws, message) {
      if (ws.data.type === "chat") chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws, message as string);
      else ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws);
    },
  },
});
// What `src/server/index.ts` records once it listens: the tool endpoints' URLs are built from it.
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
setServerListenAddress(server.port ?? port, "127.0.0.1");
console.log(`ppm-tool-cards fixture on ${port}`);
