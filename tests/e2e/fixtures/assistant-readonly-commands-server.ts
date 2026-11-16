/**
 * Served-production fixture for the PPM Assistant's read-only-command e2e
 * (tests/e2e/assistant-readonly-commands-e2e.mjs). Unlike `assistant-server.ts` it runs the REAL
 * Claude provider and the real CLI subprocess, so every tool call goes through PPM's real
 * PreToolUse hook: the CLI talks to `bash-script-anthropic-api.ts`, a stand-in for
 * api.anthropic.com that turns the message's `RUN:` / `PS:` / `EDIT:` lines into tool calls.
 *
 * Requires an isolated home and an empty PPM_HOME (refuses the real ones), serves the scratch Vite
 * bundle in PPM_RO_WEB_DIR when one is given (the PowerShell leg drives a bare chat socket and
 * needs none). Test endpoints: GET /__ro-test/api (every request the fake API saw: the tools the
 * CLI offered and the results it sent back), POST /__ro-test/exit.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { startBashScriptApi } from "./bash-script-anthropic-api.ts";

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
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8081 || (port >= 3210 && port <= 3212)) {
  throw new Error("Invalid fixture port (8081 and 3210-3212 belong to dev and production)");
}
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.DISABLE_TELEMETRY = "1";
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
// The CLI offers its PowerShell tool on Windows only when told to (Git Bash is there too).
if (process.platform === "win32") process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "1";

const api = startBashScriptApi();
// The CLI subprocess inherits this (`buildQueryEnv` passes the shell's ANTHROPIC_BASE_URL on).
process.env.ANTHROPIC_BASE_URL = api.url;

// PPM's own calls to api.anthropic.com (the usage poller, a token refresh) never leave the
// machine carrying a made-up token.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.anthropic.com/") || url.startsWith("https://console.anthropic.com/")) {
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
await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();

// One signed-in account a day from expiry, so no renewal runs during the test.
const { accountService } = await import("../../../src/services/account.service");
accountService.add({
  email: "readonly@fixture.test", label: "Fixture account",
  accessToken: "sk-ant-oat01-fake-readonly", refreshToken: "refresh-readonly",
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
});

const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { app } = await import("../../../src/server/index");
const { chatSocketData, chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

type SocketData = { type: "health" | "global" } | ReturnType<typeof chatSocketData>;
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__ro-test/api") return json({ requests: api.requests });
    if (url.pathname === "/__ro-test/exit" && req.method === "POST") {
      setTimeout(() => shutdown(), 50);
      return json({ ok: true });
    }
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = chatSocketData(parts[5] ?? "", decodeURIComponent(parts[3] ?? ""), url.searchParams);
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_RO_WEB_DIR;
      if (!webDir) return new Response("No web bundle in this run", { status: 404 });
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
      else if (ws.data.type === "global") globalWebSocket.open(ws as never);
    },
    message(ws, message) {
      if (ws.data.type === "chat") void chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws as never, message as string);
      else ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws as never);
    },
  },
});
// What `src/server/index.ts` records once it listens: the Assistant's tool URL is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
const { startAssistantHub } = await import("../../../src/services/assistant-hub/assistant-hub-startup");
await startAssistantHub({});

function shutdown() { server.stop(true); api.stop(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Read-only commands fixture ready at http://127.0.0.1:${server.port}; fake Anthropic API at ${api.url}; real Claude CLI.`);
