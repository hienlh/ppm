/**
 * Isolated real-route server for the owner-canvas thread e2e. Never use __serve__.
 *
 * Same isolation guards as `design-mode-server.ts`, but with PPM sign-in ON and a fixed
 * token, because share links refuse to exist while sign-in is off. Scripted providers only;
 * `/__threads-test/calls` answers what the design provider was handed, which is the only way
 * to see the exact text a reviewer's comment reached the model as, and
 * `POST /__threads-test/sign-in/{on,off}` switches sign-in as Settings would. A second start on
 * the PPM_HOME this fixture made is a restart: the same database, port and token.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
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
// A PPM_HOME with data is accepted only when this fixture made it (its marker), so a restart
// reopens the same database and nothing else is ever reused.
const marker = resolve(ppmHome, ".ppm-threads-fixture");
if (existsSync(resolve(ppmHome, "ppm.db")) && !existsSync(marker)) throw new Error("Fixture requires an empty PPM_HOME or one it made itself");
writeFileSync(marker, "");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8080, 8081, 3211, 3212].includes(port)) throw new Error("Invalid fixture port");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

/** The e2e signs in with this; it exists only inside the scratch PPM_HOME. */
export const THREADS_TEST_TOKEN = "threads-e2e-token";

const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: true, token: THREADS_TEST_TOKEN });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", { default_provider: "design-test", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { "design-test": { type: "mock" }, "plain-test": { type: "mock" } } });

const { DesignScriptProvider, PlainTestProvider } = await import("./design-script-provider");
const { providerRegistry } = await import("../../../src/providers/registry");
const design = new DesignScriptProvider();
const providers = [design, new PlainTestProvider()];
for (const p of providers) providerRegistry.register(p);
providerRegistry.get = (id) => providers.find((p) => p.id === id);
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = () => design;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname === "/__html-test/shutdown" && req.method === "POST") {
      setTimeout(shutdown, 50);
      return new Response("Stopping fixture");
    }
    if (url.pathname === "/__threads-test/calls") return Response.json(design.calls);
    const signIn = /^\/__threads-test\/sign-in\/(on|off)$/.exec(url.pathname);
    if (signIn && req.method === "POST") {
      configService.set("auth", { ...configService.get("auth"), enabled: signIn[1] === "on", token: THREADS_TEST_TOKEN });
      return Response.json({ enabled: configService.get("auth").enabled });
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
    if (/^\/api\/(?:tunnels?|preview|upgrade|accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
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
console.log(`Design-threads fixture ready at http://127.0.0.1:${server.port}; sign-in on, scripted providers only.`);
