/** Served-production fixture for renewing a Claude sign-in under live chats.
 *
 * Unlike the scripted fixtures this runs the REAL Claude provider and the real CLI subprocess,
 * pointed at `fake-anthropic-api.ts`, which revokes an access token the moment a newer one is
 * issued — the behaviour that used to cut turns short. The isolated account starts an hour
 * from expiry, inside the early-renewal window, so a sweep renews it whenever it is quiet.
 *
 * Requires an isolated home/config and serves the scratch Vite bundle in PPM_ROTATION_WEB_DIR.
 * Test endpoints: GET /__rotation-test/state, POST /__rotation-test/sweep, POST /__rotation-test/force-renew.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { startFakeAnthropicApi } from "./fake-anthropic-api.ts";

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
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.DISABLE_TELEMETRY = "1";
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

const FIRST_TOKEN = "sk-ant-oat01-fake-0";
const api = startFakeAnthropicApi({ firstToken: FIRST_TOKEN, slowChunkDelayMs: Number(process.env.PPM_ROTATION_SLOW_MS ?? 700) });
// The CLI subprocess inherits this (`buildQueryEnv` passes the shell's ANTHROPIC_BASE_URL on).
process.env.ANTHROPIC_BASE_URL = api.url;

// PPM's own calls to api.anthropic.com — the refresh grant, the usage poller — go to the fake
// too. Nothing in this process may reach the real endpoint carrying a made-up token.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.anthropic.com/")) {
    const path = url.slice("https://api.anthropic.com".length);
    if (path.startsWith("/v1/oauth/token")) return realFetch(api.url + path, init);
    return Promise.resolve(new Response("not available in fixture", { status: 404 }));
  }
  return realFetch(input as any, init);
}) as typeof fetch;

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
const ai = configService.get("ai");
configService.set("ai", {
  ...ai, default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { ...ai.providers.claude, type: "agent-sdk", permission_mode: "bypassPermissions", model: "claude-sonnet-5" } },
});

const { accountService } = await import("../../../src/services/account.service");
const account = accountService.add({
  email: "rotation@fixture.test",
  label: "Fixture account",
  accessToken: FIRST_TOKEN,
  refreshToken: "refresh-0",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { runTokenRotationSweep } = await import("../../../src/server/ws/chat-token-rotation");

/** Account routes that only read the isolated database. */
function accountRouteAllowed(method: string, path: string): boolean {
  if (method === "GET") return /^\/api\/accounts(?:\/active|\/settings|\/usage|\/[^/]+\/usage)?$/.test(path);
  return method === "POST" && path === "/api/accounts/pick";
}

function state() {
  const acc = accountService.getWithTokens(account.id);
  return {
    accountId: account.id,
    currentToken: acc?.accessToken ?? null,
    expiresInS: acc?.expiresAt ? acc.expiresAt - Math.floor(Date.now() / 1000) : null,
    issued: api.issued,
    requests: api.requests,
  };
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  async fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__rotation-test/state") return Response.json(state());
    if (url.pathname === "/__rotation-test/sweep" && req.method === "POST") {
      await runTokenRotationSweep();
      return Response.json(state());
    }
    if (url.pathname === "/__rotation-test/force-renew" && req.method === "POST") {
      // What the point-of-use renewal does five minutes before expiry, busy or not.
      await accountService.refreshAccessToken(account.id, false, true);
      return Response.json(state());
    }
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
      const webDir = process.env.PPM_ROTATION_WEB_DIR;
      if (!webDir) throw new Error("PPM_ROTATION_WEB_DIR required");
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
function shutdown() { server.stop(true); api.stop(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Token-rotation fixture ready at http://127.0.0.1:${server.port}; fake Anthropic API at ${api.url}.`);
