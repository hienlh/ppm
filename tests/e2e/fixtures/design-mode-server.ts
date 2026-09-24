/**
 * Isolated real-route server for the design-mode e2e. Never use __serve__.
 *
 * The html-preview fixture's isolation guards, plus what Design mode needs on top: the chat,
 * global and health WebSockets and two scripted providers (one design-capable, one not).
 * The `/__design-test/*` routes are test hooks into server state the UI cannot show — what
 * the provider was handed, a session's stored mode, a preview token's expiry — and exist
 * only in this fixture.
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
configService.set("ai", { default_provider: "design-test", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { "design-test": { type: "mock" }, "plain-test": { type: "mock" } } });

const { DesignScriptProvider, PlainTestProvider } = await import("./design-script-provider");
const { providerRegistry } = await import("../../../src/providers/registry");
const design = new DesignScriptProvider();
const plain = new PlainTestProvider();
const providers = [design, plain];
for (const p of providers) providerRegistry.register(p);
// Keep imported production provider instances unreachable, including aggregate history routes.
providerRegistry.get = (id) => providers.find((p) => p.id === id);
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = () => design;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { getSessionDesignSlug, getSessionPermissionMode } = await import("../../../src/services/db.service");
const { designPreviewRoutes } = await import("../../../src/server/routes/design-preview");
const { buildDesignCsp } = await import("../../../src/services/design/preview/design-csp");
const { flushTurnSnapshots, pendingTurnSnapshotCount } = await import("../../../src/services/design/design-turn-snapshot");

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Test hooks; the shape of each answer is what the e2e asserts on, nothing more. */
async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__design-test/calls") return json(design.calls);
  if (path === "/__design-test/pending-snapshots") return json({ pending: pendingTurnSnapshotCount() });
  // Nothing debouncing any more: wait for the snapshot writes already under way to finish.
  if (path === "/__design-test/settle-snapshots" && req.method === "POST") {
    await flushTurnSnapshots();
    return json({ settled: true });
  }
  if (path === "/__design-test/csp") {
    const source = new URL(req.url).searchParams.get("source") ?? "";
    return json({ canvas: buildDesignCsp(source), print: buildDesignCsp(source, { allowModals: true }) });
  }
  const session = /^\/__design-test\/session\/([^/]+)$/.exec(path);
  if (session) return json({ designSlug: getSessionDesignSlug(session[1]!), permissionMode: getSessionPermissionMode(session[1]!) });
  const token = /^\/__design-test\/token\/([0-9a-f-]{36})(\/expire)?$/.exec(path);
  if (token) {
    const cap = designPreviewRoutes.store.resolve(token[1]!);
    if (!cap) return json(null, 404);
    if (token[2] && req.method === "POST") {
      // Stands in for the idle timeout lapsing: resolve() drops a token past its idle expiry.
      cap.idleExpires = 0;
      return json({ expired: true });
    }
    return json({ purpose: cap.purpose, slug: cap.slug, idleExpires: cap.idleExpires, hardExpires: cap.hardExpires });
  }
  return json({ error: "unknown test route" }, 404);
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
    if (url.pathname.startsWith("/__design-test/")) return testRoute(req, url.pathname);
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
console.log(`Design-mode fixture ready at http://127.0.0.1:${server.port}; scripted providers only.`);
