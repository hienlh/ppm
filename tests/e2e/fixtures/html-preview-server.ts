/** Minimal real-route HTML preview fixture. No production home, AI calls or tunnels. */
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
configService.set("ai", { default_provider: "html-preview-test", share_provider_context: false, providers: {} });
const { providerRegistry } = await import("../../../src/providers/registry");
providerRegistry.get = () => undefined;
providerRegistry.list = () => [];
providerRegistry.listAll = () => [];

const { app } = await import("../../../src/server/index");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const server = Bun.serve<{ type: "health" | "global" }>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const path = new URL(req.url).pathname;
    if (path === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
    }
    if (path === "/ws/health" || path === "/ws/global") {
      return instance.upgrade(req, { data: { type: path === "/ws/health" ? "health" : "global" } })
        ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    if (path.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:tunnels?|preview|upgrade|accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(path) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(path)) return new Response("Disabled in fixture", { status: 403 });
    return app.fetch(req, instance);
  },
  websocket: {
    open(ws) { if (ws.data.type === "global") globalWebSocket.open(ws); },
    message(ws, message) {
      if (ws.data.type === "health") ws.send("pong");
      else globalWebSocket.message(ws, message as string);
    },
    close(ws) { if (ws.data.type === "global") globalWebSocket.close(ws); },
  },
});
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
