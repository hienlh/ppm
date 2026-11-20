/**
 * Served-production fixture for the file browser's path features (tests/e2e/file-browser-paths-e2e.mjs),
 * adapted from ppm-tool-cards-server. Requires an isolated home and PPM directory, serves the
 * scratch Vite bundle named by PPM_FB_WEB_DIR, and answers every turn — an ordinary chat's or the
 * PPM Assistant's — with a scripted provider: each scripted tool call goes to PPM's real MCP
 * endpoint (ppm-tabs, ppm-assistant) with the token the turn was handed, as the CLIs do, and each
 * scripted text is streamed as the answer.
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
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
const { stringifyToolResultContent } = await import("../../../src/shared/tool-result-content");

/** One scripted step: a call to one of PPM's own MCP servers, or text the answer streams. */
type ScriptOp = { tool: string; input: Record<string, unknown> } | { text: string };
type Access = { url: string; token: string } | undefined;

const SERVERS: Record<string, (opts: SendOpts | undefined) => Access> = {
  "ppm-tabs": (opts) => opts?.tabToolsMcp,
  "ppm-assistant": (opts) => (opts as { assistantMcp?: Access } | undefined)?.assistantMcp,
};

/** The answer PPM's endpoint gives a real call, as the Claude provider hands it to the chat. */
async function callReal(tool: string, input: Record<string, unknown>, opts: SendOpts | undefined): Promise<{ output: string; isError: boolean }> {
  const m = /^mcp__(ppm-tabs|ppm-assistant)__(.+)$/.exec(tool);
  const access = m ? SERVERS[m[1]!]!(opts) : undefined;
  if (!m || !access) return { output: `fixture: this turn was not handed that server (it got: ${Object.keys(opts ?? {}).join(", ")})`, isError: true };
  const response = await fetch(access.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: m[2], arguments: input } }),
  });
  const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
  return { output: stringifyToolResultContent((body?.result?.content ?? []) as never), isError: body?.result?.isError === true };
}
const realAnswers: Array<{ tool: string; output: string; isError: boolean }> = [];

let script: ScriptOp[] = [];
let turnCount = 0;

class PathsMock extends MockProvider {
  /** The PPM Assistant runs on it too, so its ui_open_file_browser call is under test. */
  readonly supportsAssistantSessions = true;
  private history = new Map<string, ChatMessage[]>();
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
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
    let text = "";
    for (const op of ops) {
      if ("text" in op) {
        text += op.text;
        const ev = { type: "text", content: op.text } as ChatEvent;
        events.push(ev);
        yield ev;
        continue;
      }
      const toolUseId = `tu-${crypto.randomUUID()}`;
      const use = { type: "tool_use", tool: op.tool, input: op.input, toolUseId } as ChatEvent;
      events.push(use);
      yield use;
      const answer = await callReal(op.tool, op.input, opts);
      realAnswers.push({ tool: op.tool, ...answer });
      const result = { type: "tool_result", output: answer.output, isError: answer.isError, toolUseId } as ChatEvent;
      events.push(result);
      yield result;
    }
    // Numbered, so the e2e can tell when this turn's answer is on screen.
    const tail = `\n\nTurn ${++turnCount}: done.`;
    text += tail;
    const end = { type: "text", content: tail } as ChatEvent;
    events.push(end);
    yield end;
    history.push({ id: crypto.randomUUID(), role: "assistant", content: text, events, timestamp: new Date().toISOString() } as ChatMessage);
    this.history.set(sessionId, history);
    yield { type: "done", sessionId };
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new PathsMock();
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
  if (path === "/__fb-test/script" && req.method === "POST") {
    script = (await req.json() as { ops: ScriptOp[] }).ops;
    return json({ ok: true, ops: script.length });
  }
  if (path === "/__fb-test/state") return json({ turns: turnCount, answers: realAnswers });
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__fb-test/")) return testRoute(req, url.pathname);
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
      const webDir = process.env.PPM_FB_WEB_DIR;
      if (!webDir) throw new Error("PPM_FB_WEB_DIR required");
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
console.log(`file-browser-paths fixture on ${port}`);
