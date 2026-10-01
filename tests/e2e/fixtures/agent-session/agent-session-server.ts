/**
 * Isolated real-route server for the agent-session-window e2e.
 *
 * Unlike design-mode-server.ts this keeps the REAL provider registry (including the real
 * "claude" provider) — the test never sends a chat message or spawns a CLI subprocess, it only
 * reads history/transcripts from disk (`provider.getMessages`, the agent-transcript hub), which
 * are pure filesystem reads keyed off `HOME`/`USERPROFILE` (already pointed at the sandbox by
 * the harness). Auth is disabled the same way every other html-preview fixture disables it.
 *
 * Never use __serve__ — that is the real CLI entrypoint and is blocked by prod-db-guard.ts.
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
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
// claudeProjectsRoot()/codexSessionsDirs() derive from homedir() directly — HOME/USERPROFILE
// above already point them at the sandbox; no CLAUDE_CONFIG_DIR override needed (or wanted:
// that env var is not what those two modules read).

const { configService } = await import("../../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);

const { app } = await import("../../../../src/server/index");
const { chatWebSocket } = await import("../../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../../src/server/ws/global");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
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
    // Nothing in this e2e touches tunnels/accounts/proxy/mcp/remote-desktop; keep them off so a
    // stray route never tries real network or spawns something outside the sandbox.
    if (/^\/api\/(?:tunnels?|preview|upgrade|accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
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
console.log(`Agent-session fixture ready at http://127.0.0.1:${server.port}; real provider registry, no live sends.`);
