/** Served-production fixture for a chat whose transcript Claude Code no longer has.
 *
 * Runs the REAL Claude provider and the real CLI subprocess against `fake-anthropic-api.ts`, with
 * Claude's config folder inside the sandbox (CLAUDE_CONFIG_DIR), no PPM account and a made-up API
 * key. A test deletes a chat's transcript the way a wiped `~/.claude` does; the CLI then answers
 * the next resume with "No conversation found", exactly as on a user's machine.
 *
 * Requires an isolated home/config and serves the scratch Vite bundle in PPM_RESUME_WEB_DIR.
 * Test endpoints: GET /__resume-test/state, POST /__resume-test/delete-transcript { sessionId }.
 */
import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
const claudeConfig = resolve(sandboxHome, ".claude");
process.env.CLAUDE_CONFIG_DIR = claudeConfig;
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.DISABLE_TELEMETRY = "1";
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

const FAKE_KEY = "sk-ant-api03-fixture-not-a-real-key";
const api = startFakeAnthropicApi({ firstToken: FAKE_KEY });
// The CLI subprocess inherits both (`buildQueryEnv` passes the shell's key and base URL on when
// there is no PPM account), so every request it makes goes to the fake with the made-up key.
process.env.ANTHROPIC_BASE_URL = api.url;
process.env.ANTHROPIC_API_KEY = FAKE_KEY;

// Nothing in this process may reach the real endpoint carrying a made-up key.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.anthropic.com/")) return Promise.resolve(new Response("not available in fixture", { status: 404 }));
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

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

/** Delete a chat's transcript from the sandboxed Claude config, as a wiped `~/.claude` does. */
function deleteTranscript(sessionId: string): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("bad session id");
  const projects = join(claudeConfig, "projects");
  const removed: string[] = [];
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) { rmSync(file); removed.push(file); }
  }
  return removed;
}

function state() {
  return {
    claudeConfig,
    resumeRecovery: configService.get("ai").resume_recovery ?? null,
    requests: api.requests,
    prompts: api.prompts,
  };
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  async fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__resume-test/state") return Response.json(state());
    if (url.pathname === "/__resume-test/delete-transcript" && req.method === "POST") {
      const { sessionId } = await req.json() as { sessionId: string };
      return Response.json({ removed: deleteTranscript(sessionId) });
    }
    if (url.pathname === "/__resume-test/release-cli" && req.method === "POST") {
      // What releasing a quiet chat's subprocess (or a restart) does: the next message needs a new
      // CLI, which has to resume from the transcript. A live CLI holds the chat in memory instead.
      const { sessionId } = await req.json() as { sessionId: string };
      const { providerRegistry } = await import("../../../src/providers/registry");
      const claude = providerRegistry.get("claude") as any;
      const had = !!claude?.hasStreamingSession?.(sessionId);
      claude?.closeStreamingSession?.(sessionId);
      return Response.json({ released: had });
    }
    if (url.pathname === "/__resume-test/shutdown" && req.method === "POST") {
      // Close every live CLI first: on Windows the CLI subprocesses outlive a killed server.
      const { providerRegistry } = await import("../../../src/providers/registry");
      const claude = providerRegistry.get("claude") as any;
      for (const id of [...(claude?.streamingSessions?.keys?.() ?? [])]) claude.closeStreamingSession(id);
      setTimeout(shutdown, 1500);
      return Response.json({ closing: true, pid: process.pid });
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
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) && req.method !== "GET") {
      return new Response("Disabled in fixture", { status: 403 });
    }
    if (/^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_RESUME_WEB_DIR;
      if (!webDir) throw new Error("PPM_RESUME_WEB_DIR required");
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
console.log(`Resume-session-missing fixture ready at http://127.0.0.1:${server.port} (pid ${process.pid}); fake Anthropic API at ${api.url}.`);
