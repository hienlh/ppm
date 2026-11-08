/**
 * Served-production fixture for the tour's "PPM has new features" part (tests/e2e/feature-intros-e2e.mjs).
 * One fresh, isolated install per start: an empty PPM_HOME, no project, nothing answered. Serves the
 * scratch Vite bundle named by PPM_INTRO_WEB_DIR and one scripted provider whose turn lists the
 * session tools it was handed (`tools/list` on the real `/api/sessions-mcp` with the turn's own
 * token) and says them in the chat. No real SDK or CLI runs, and no real user data is read.
 *
 * Its own routes (`/__intro-test/*`) only read state and do what happens outside the browser:
 * `ppm config set ai.ppm_tools…` (`raw-switch`), a chat turn being recorded for a session
 * (`session-metadata`), and the next day arriving (`later-day`, which moves the last counted skip
 * back past the one-skip window). The question itself is never answered here.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ChatEvent, ChatMessage } from "../../../src/providers/provider.interface";
import type { SendMessageOpts } from "../../../src/types/chat";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`) || canonical(homedir()) !== privateHome) {
  throw new Error("Refusing the production home or PPM directory");
}
if (existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3211, 3212, 3213, 3214, 8080, 8081].includes(port)) throw new Error("Invalid fixture port");
const projectsDir = process.env.PPM_INTRO_PROJECTS;
const webDir = process.env.PPM_INTRO_WEB_DIR;
if (!projectsDir || !existsSync(projectsDir) || !webDir) throw new Error("PPM_INTRO_PROJECTS and PPM_INTRO_WEB_DIR required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

const alpha = join(projectsDir, "alpha");
mkdirSync(alpha, { recursive: true });

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "intro-test", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { "intro-test": { type: "mock" } },
} as never);

/**
 * Each turn the provider ran: which of the introduced feature's six tools PPM handed it, listed by
 * the two endpoints that serve them (history tools on `/api/tab-tools-mcp`, the others on
 * `/api/sessions-mcp`), with the HTTP status of each `tools/list` asked.
 */
const turns: Array<{ sessionId: string; tools: string[]; statuses: number[] }> = [];
const { FEATURE_INTROS, FEATURE_INTRO_SKIP_WINDOW_MS } = await import("../../../src/shared/feature-intros");
const INTRO_TOOLS: readonly string[] = FEATURE_INTROS[0]!.tools;

async function listTools(access: { url: string; token: string } | undefined, statuses: number[]): Promise<string[]> {
  if (!access) return [];
  const res = await fetch(access.url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  statuses.push(res.status);
  const body = await res.json().catch(() => null) as { result?: { tools?: Array<{ name: string }> } } | null;
  return (body?.result?.tools ?? []).map((t) => t.name);
}

const { MockProvider } = await import("../../../src/providers/mock-provider");
const { providerRegistry } = await import("../../../src/providers/registry");
class IntroTestProvider extends MockProvider {
  override id = "intro-test";
  override name = "Intro test AI";
  private answers = new Map<string, ChatMessage[]>();
  override async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const statuses: number[] = [];
    const listed = [...await listTools(opts?.tabToolsMcp, statuses), ...await listTools(opts?.sessionCollabMcp, statuses)];
    const tools = listed.filter((name) => INTRO_TOOLS.includes(name)).sort();
    turns.push({ sessionId, tools, statuses });
    const answer = tools.length ? `Session tools handed to this turn: ${tools.join(", ")}.` : "No session tools were handed to this turn.";
    const history = this.answers.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    yield { type: "text", content: answer };
    history.push({ id: crypto.randomUUID(), role: "assistant", content: answer, timestamp: new Date().toISOString() });
    this.answers.set(sessionId, history);
    yield { type: "done", sessionId };
  }
  override async getMessages(sessionId: string) { return this.answers.get(sessionId) ?? []; }
}
const provider = new IntroTestProvider();
providerRegistry.register(provider);
providerRegistry.get = ((id: string) => (id === provider.id ? provider : undefined)) as typeof providerRegistry.get;
providerRegistry.list = () => [{ id: provider.id, name: provider.name }];
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => provider) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { setSessionMetadata, setSessionProvider } = await import("../../../src/services/db.service");

const json = (body: unknown, status = 200) => Response.json(body, { status });
async function testRoute(req: Request, path: string): Promise<Response> {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  if (path === "/project") return json({ alpha });
  if (path === "/turns") return json({ turns });
  if (path === "/state") return json({ featureIntros: configService.get("feature_intros") ?? {}, ppmTools: configService.get("ai").ppm_tools ?? {} });
  if (path === "/session-metadata" && req.method === "POST") {
    // What a chat's first turn records; one such row is what makes an install "in use".
    setSessionMetadata(String(body.sessionId), "alpha", alpha);
    setSessionProvider(String(body.sessionId), provider.id);
    return json({ ok: true });
  }
  if (path === "/later-day" && req.method === "POST") {
    // The next app open comes after the skip window: the last counted skip is moved back past it.
    const states = (configService.get("feature_intros") ?? {}) as Record<string, { lastSkipAt?: string }>;
    const id = String(body.id);
    const last = states[id]?.lastSkipAt;
    if (!last) return json({ error: "no skip recorded yet" }, 409);
    const lastSkipAt = new Date(Date.parse(last) - FEATURE_INTRO_SKIP_WINDOW_MS - 60_000).toISOString();
    configService.set("feature_intros", { ...states, [id]: { ...states[id], lastSkipAt } } as never);
    return json({ ok: true, lastSkipAt });
  }
  if (path === "/raw-switch" && req.method === "POST") {
    // `ppm config set` (or an older build) writing a switch with no route seeing it.
    const ai = configService.get("ai");
    configService.set("ai", { ...ai, ppm_tools: { ...ai.ppm_tools, [String(body.tool)]: body.on === true } });
    return json({ ok: true });
  }
  return json({ error: `unknown test route ${path}` }, 404);
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__intro-test/")) return testRoute(req, url.pathname.slice("/__intro-test".length));
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
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (relative.includes("..")) return new Response("Invalid path", { status: 400 });
      const file = Bun.file(resolve(webDir, relative || "index.html"));
      return file.exists().then((found) => new Response(found ? file : Bun.file(resolve(webDir, "index.html"))));
    }
    return app.fetch(req, instance);
  },
  websocket: {
    idleTimeout: 960,
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
// What `src/server/index.ts` records once it listens: the MCP endpoints' URLs are built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Feature-intros fixture ready at http://127.0.0.1:${server.port}; scripted provider only, nothing answered.`);
