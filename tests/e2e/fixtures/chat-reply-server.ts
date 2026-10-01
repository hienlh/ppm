/** Served-production chat reply fixture. Adapted from new-chat-instant-server.
 * Requires isolated home/config, uses only recorded mock providers, and serves the
 * scratch Vite bundle specified by PPM_REPLY_WEB_DIR. No real SDK or CLI turns.
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
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" }, "plain-test": { type: "mock" } },
});

const { MockProvider } = await import("../../../src/providers/mock-provider");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;

interface TurnCall { providerId: string; sessionId: string; message: string; permissionMode: string | null; at: number }
const turns: TurnCall[] = [];
const skillCalls: { at: number; cold: boolean }[] = [];
/** How long a skill listing takes after `invalidateSkillsCache` — a cold server-side list. */
let coldSkillMs = 3000;

/** A mock whose turns are recorded and whose skill list is slow only when cold. */
class ReplyMock extends MockProvider {
  private skillsWarm = true;
  constructor(id: string, name: string, private skillName: string) {
    super();
    this.id = id;
    this.name = name;
  }
  invalidateSkillsCache(): void { this.skillsWarm = false; }
  async listSkills(): Promise<Array<{ name: string; description: string; scope: string; path: string; enabled: boolean }>> {
    const cold = !this.skillsWarm;
    skillCalls.push({ at: Date.now(), cold });
    if (cold) await new Promise((r) => setTimeout(r, coldSkillMs));
    this.skillsWarm = true;
    return [{ name: this.skillName, description: "Scripted e2e skill", scope: "user", path: "", enabled: true }];
  }
  override async *sendMessage(sessionId: string, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    turns.push({
      providerId: this.id, sessionId, message, at: Date.now(),
      permissionMode: typeof opts?.permissionMode === "string" ? opts.permissionMode : null,
    });
    yield* super.sendMessage(sessionId, message, opts);
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ReplyMock("claude", "Claude", "instant-e2e-skill");
const plain = new ReplyMock("plain-test", "Plain test AI", "plain-e2e-skill");
const providers = [claude, plain];
for (const p of providers) providerRegistry.register(p as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

// Two placeholder accounts for the round-robin pick. Counted by wrapping the selector's
// own `next()`, which is what both `/chat/prepare` and `/api/accounts/pick` consume.
const { accountService } = await import("../../../src/services/account.service");
const { accountSelector } = await import("../../../src/services/account-selector.service");
const farFuture = Math.floor(Date.now() / 1000) + 30 * 86400;
for (const who of ["alpha", "beta"]) {
  accountService.add({ email: `${who}@e2e.invalid`, label: `E2E ${who}`, accessToken: `placeholder-${who}`, refreshToken: `placeholder-${who}`, expiresAt: farFuture });
}
const picks: { id: string | null; at: number }[] = [];
const originalNext = accountSelector.next.bind(accountSelector);
accountSelector.next = ((...args: unknown[]) => {
  const picked = (originalNext as (...a: unknown[]) => { id: string } | null)(...args);
  picks.push({ id: picked?.id ?? null, at: Date.now() });
  return picked;
}) as typeof accountSelector.next;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__instant-test/state") {
    return json({ picks, turns, skillCalls, coldSkillMs, accounts: accountService.list().map((a) => ({ id: a.id, label: a.label })) });
  }
  if (path === "/__instant-test/permission" && req.method === "POST") {
    const { provider, mode } = await req.json() as { provider: string; mode: string };
    const ai = configService.get("ai");
    configService.set("ai", { ...ai, providers: { ...ai.providers, [provider]: { ...ai.providers[provider], permission_mode: mode } } } as never);
    return json({ ok: true, permission: configService.get("ai").providers[provider]?.permission_mode });
  }
  if (path === "/__instant-test/cold-skill-ms" && req.method === "POST") {
    coldSkillMs = Number((await req.json() as { ms: number }).ms);
    return json({ coldSkillMs });
  }
  return json({ error: "unknown test route" }, 404);
}

/** Account routes that only read the isolated database; everything else (OAuth, refresh,
 * verify, import/export) would reach a real endpoint and stays disabled. */
function accountRouteAllowed(method: string, path: string): boolean {
  if (method === "GET") return /^\/api\/accounts(?:\/active|\/settings|\/usage|\/[^/]+\/usage)?$/.test(path);
  return method === "POST" && path === "/api/accounts/pick";
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
    }
    if (url.pathname.startsWith("/__instant-test/")) return testRoute(req, url.pathname);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/accounts(?:\/|$)/.test(url.pathname) && !accountRouteAllowed(req.method, url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
    }
    if (/^\/api\/(?:tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_REPLY_WEB_DIR;
      if (!webDir) throw new Error("PPM_REPLY_WEB_DIR required");
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
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Chat-reply fixture ready at http://127.0.0.1:${server.port}; scripted providers only.`);
