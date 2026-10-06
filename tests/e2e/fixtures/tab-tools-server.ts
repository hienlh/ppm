/** Served-production fixture for the AI's tab tools (`open_file`, `open_preview`). Adapted from
 * session-changes-server. Requires an isolated home and PPM directory, serves the scratch Vite
 * bundle named by PPM_TAB_TOOLS_WEB_DIR, and answers every turn with a scripted provider that
 * calls the real `/api/tab-tools-mcp` endpoint the way the Claude CLI does — with the bearer
 * token the turn was handed — and reports the result as the tool's result. No real SDK or CLI.
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
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

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

const { MockProvider } = await import("../../../src/providers/mock-provider");
const { stringifyToolResultContent } = await import("../../../src/shared/tool-result-content");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;

/**
 * One tool call a scripted turn makes; `as` picks which provider's tool name the card sees, and
 * `wait` is how long the agent "thinks" before calling it.
 */
type ScriptOp = { tool: "open_file" | "open_preview"; args: Record<string, unknown>; as?: "claude" | "codex"; wait?: number };
interface CallRecord {
  sessionId: string;
  op: ScriptOp;
  /** Whether the turn carried the tools, or the call reused a token an earlier turn was given. */
  handed: boolean;
  status?: number;
  isError?: boolean;
  text?: string;
  image?: { mimeType: string; bytes: number };
  ms?: number;
}

let script: ScriptOp[] = [];
let turnCount = 0;
const calls: CallRecord[] = [];
/** A running chat keeps the tools it started with; turning the setting off must still be enforced. */
const lastAccess = new Map<string, { url: string; token: string }>();

class TabToolsMock extends MockProvider {
  private history = new Map<string, ChatMessage[]>();
  constructor() {
    super();
    this.id = "claude";
    this.name = "Claude";
  }
  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }
  override async *sendMessage(sessionId: string, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    yield { type: "system" as never, subtype: "init" } as never;
    if (opts?.tabToolsMcp) lastAccess.set(sessionId, opts.tabToolsMcp);
    const access = opts?.tabToolsMcp ?? lastAccess.get(sessionId);
    const events: ChatEvent[] = [];
    const ops = script;
    script = [];
    for (const op of ops) {
      const record: CallRecord = { sessionId, op, handed: !!opts?.tabToolsMcp };
      calls.push(record);
      const toolUseId = `tu-${crypto.randomUUID()}`;
      const use = (op.as === "codex"
        ? { type: "tool_use", tool: `ppm_tabs:${op.tool}`, input: { server: "ppm_tabs", tool: op.tool, arguments: op.args }, toolUseId }
        : { type: "tool_use", tool: `mcp__ppm-tabs__${op.tool}`, input: op.args, toolUseId }) as ChatEvent;
      events.push(use);
      yield use;
      if (!access) {
        record.text = "no tab tools";
        const result = { type: "tool_result", output: "No such tool available: the turn was not given the tab tools", isError: true, toolUseId } as ChatEvent;
        events.push(result);
        yield result;
        continue;
      }
      if (op.wait) await new Promise((r) => setTimeout(r, op.wait));
      const started = Date.now();
      const response = await fetch(access.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.tool, arguments: op.args } }),
      });
      record.status = response.status;
      record.ms = Date.now() - started;
      const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
      const content = body?.result?.content ?? [];
      record.isError = body?.result?.isError === true;
      record.text = content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
      const image = content.find((b) => b.type === "image");
      if (image) record.image = { mimeType: String(image.mimeType), bytes: Math.floor(String(image.data ?? "").length * 3 / 4) };
      // What the Claude provider hands the chat: image blocks become placeholders.
      const output = stringifyToolResultContent(content.map((b) => b.type === "image"
        ? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
        : b));
      const result = { type: "tool_result", output, isError: record.isError, toolUseId } as ChatEvent;
      events.push(result);
      yield result;
    }
    // Numbered, so the e2e can tell when this turn's answer is on screen.
    const text = `Turn ${++turnCount}: ${ops.length ? `called ${ops.map((o) => o.tool).join(", ")}` : "nothing to do"}.`;
    yield { type: "text", content: text };
    history.push({ id: crypto.randomUUID(), role: "assistant", content: text, events, timestamp: new Date().toISOString() } as ChatMessage);
    this.history.set(sessionId, history);
    yield { type: "done", sessionId };
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new TabToolsMock();
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
  if (path === "/__tab-test/calls") return json({ calls });
  if (path === "/__tab-test/script" && req.method === "POST") {
    script = (await req.json() as { ops: ScriptOp[] }).ops;
    return json({ ok: true, ops: script.length });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__tab-test/")) return testRoute(req, url.pathname);
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
      const webDir = process.env.PPM_TAB_TOOLS_WEB_DIR;
      if (!webDir) throw new Error("PPM_TAB_TOOLS_WEB_DIR required");
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
// What `src/server/index.ts` records once it listens: the tab tools' URL is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Tab-tools fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
