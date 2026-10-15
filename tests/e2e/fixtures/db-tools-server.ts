/** Served-production fixture for the AI's database tools (`db_query`, `open_query`, `db_execute`).
 * Adapted from tab-tools-server. Requires an isolated home and PPM directory, serves the scratch
 * Vite bundle named by PPM_DB_TOOLS_WEB_DIR, keeps PPM's auth on with the token the driver passes
 * in PPM_DB_TOOLS_E2E_TOKEN (PPM's password, for the approval card), and answers every turn with a
 * scripted provider that calls the real `/api/db-tools-mcp` endpoint the way the Claude CLI does —
 * with the bearer token the turn was handed. No real SDK or CLI.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

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
const token = process.env.PPM_DB_TOOLS_E2E_TOKEN;
if (!token || token.length < 12) throw new Error("PPM_DB_TOOLS_E2E_TOKEN required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: true, token });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
});

const { MockProvider } = await import("../../../src/providers/mock-provider");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;

/** One tool call a scripted turn makes; `as` picks which provider's tool name the card sees. */
type ScriptOp = { tool: "db_query" | "open_query" | "db_execute"; args: Record<string, unknown>; as?: "claude" | "codex" };
interface CallRecord { sessionId: string; op: ScriptOp; handed: boolean; status?: number; isError?: boolean; text?: string }

let script: ScriptOp[] = [];
let turnCount = 0;
const calls: CallRecord[] = [];

class DbToolsMock extends MockProvider {
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
    const access = opts?.dbToolsMcp;
    const events: ChatEvent[] = [];
    const ops = script;
    script = [];
    for (const op of ops) {
      const record: CallRecord = { sessionId, op, handed: !!access };
      calls.push(record);
      const toolUseId = `tu-${crypto.randomUUID()}`;
      const use = (op.as === "codex"
        ? { type: "tool_use", tool: `ppm_db:${op.tool}`, input: { server: "ppm_db", tool: op.tool, arguments: op.args }, toolUseId }
        : { type: "tool_use", tool: `mcp__ppm-db__${op.tool}`, input: op.args, toolUseId }) as ChatEvent;
      events.push(use);
      yield use;
      if (!access) {
        record.text = "no database tools";
        const result = { type: "tool_result", output: "No such tool available: the turn was not given the database tools", isError: true, toolUseId } as ChatEvent;
        events.push(result);
        yield result;
        continue;
      }
      const response = await fetch(access.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.tool, arguments: op.args } }),
      });
      record.status = response.status;
      const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
      record.isError = body?.result?.isError === true;
      record.text = (body?.result?.content ?? []).filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
      const result = { type: "tool_result", output: record.text, isError: record.isError, toolUseId } as ChatEvent;
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
const claude = new DbToolsMock();
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
const targetDb = resolve(sandboxHome, "target.db");

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__db-test/calls") return json({ calls });
  if (path === "/__db-test/script" && req.method === "POST") {
    script = (await req.json() as { ops: ScriptOp[] }).ops;
    return json({ ok: true, ops: script.length });
  }
  // The database the connections point at: a file in the sandbox home, never anything of the user's.
  if (path === "/__db-test/seed" && req.method === "POST") {
    const db = new Database(targetDb, { create: true });
    db.exec("DROP TABLE IF EXISTS items; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    db.close();
    return json({ path: targetDb });
  }
  if (path === "/__db-test/rows") {
    const db = new Database(targetDb, { readonly: true });
    try {
      return json({ rows: db.query("SELECT id, name FROM items ORDER BY id").all() });
    } finally {
      db.close();
    }
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__db-test/")) return testRoute(req, url.pathname);
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
      const webDir = process.env.PPM_DB_TOOLS_WEB_DIR;
      if (!webDir) throw new Error("PPM_DB_TOOLS_WEB_DIR required");
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
// What `src/server/index.ts` records once it listens: the tools' URL is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`DB-tools fixture ready at http://127.0.0.1:${server.port}; scripted provider only.`);
