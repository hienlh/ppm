/**
 * Served-production fixture for cross-session turn references. Requires an isolated home and PPM
 * directory, serves the scratch Vite bundle named by PPM_TURN_REFS_WEB_DIR, and seeds two projects
 * with real-shaped Claude transcripts and a Codex rollout (`session-turn-refs-transcripts/`). The
 * real Claude and Codex providers read them; only their turns are scripted
 * (`session-turn-refs-scripted-providers.ts`), calling the real `/api/tab-tools-mcp` endpoint with
 * the token each turn is handed. No real SDK or CLI runs, and no real user data is read.
 *
 * Uploaded images are served with a delay and no caching, so every chat image lands late and moves
 * the layout under a pinned turn, as one fetched over a slow tunnel does.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

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
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
const projectsDir = process.env.PPM_TURN_REFS_PROJECTS;
if (!projectsDir || !existsSync(projectsDir)) throw new Error("PPM_TURN_REFS_PROJECTS required");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");

const alpha = join(projectsDir, "alpha"), beta = join(projectsDir, "beta");
const claudeProjects = join(sandboxHome, ".claude", "projects"), codexSessions = join(sandboxHome, ".codex", "sessions");
for (const dir of [alpha, beta, claudeProjects, codexSessions]) mkdirSync(dir, { recursive: true });

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
  providers: { claude: { type: "agent-sdk", permission_mode: "bypassPermissions" }, codex: { type: "cli", permission_mode: "bypassPermissions" } },
} as never);
// The session tools are off until the tour's question is answered; these flows start from "Turn on".
const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
answerFeatureIntro(FEATURE_INTROS[0]!.id, "on");

const { _setClaudeProjectsRoot } = await import("../../../src/services/agent-transcript/claude-projects-root");
_setClaudeProjectsRoot(claudeProjects);
const { getUploadsDir } = await import("../../../src/services/chat-upload-storage.service");
const { seedSessions } = await import("./session-turn-refs-transcripts/seed-sessions");
const seed = seedSessions({ claudeProjects, codexSessions, uploads: getUploadsDir(), alpha, beta });

const db = await import("../../../src/services/db.service");
for (const s of [seed.A, seed.B, seed.F, seed.D, seed.C]) {
  db.setSessionMetadata(s.id, s.project, s.project === "alpha" ? alpha : beta);
  db.setSessionTitle(s.id, s.title);
}
db.setSessionProvider(seed.C.id, "codex");

// What the PreToolUse file-write hook keeps for each Write call: the "before", then both states.
const { captureBaseline } = await import("../../../src/services/session-file-baselines/session-file-baselines.service");
const { observeFile } = await import("../../../src/services/session-file-baselines/session-file-history");
for (const [w, text] of [[seed.writes.older, "older notes\n"], [seed.writes.newer, "newer notes\n"]] as const) {
  await captureBaseline(seed.A.id, w.path);
  await observeFile(seed.A.id, w.path, w.call, "before");
  mkdirSync(join(alpha, "notes"), { recursive: true });
  writeFileSync(w.path, text);
  await observeFile(seed.A.id, w.path, w.call, "after");
}

const providers = await import("./session-turn-refs-scripted-providers");
const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new providers.ScriptedClaude(claudeProjects);
const codex = new providers.ScriptedCodex(codexSessions, { [seed.C.id]: seed.transcriptOf[seed.C.id]! });
providerRegistry.register(claude as never);
providerRegistry.register(codex as never);
const visible = [claude, codex];
providerRegistry.get = ((id: string) => visible.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => visible.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

// The search index the AI's search reads, built the way the backfill builds it.
const { indexSession } = await import("../../../src/services/chat-search.service");
for (const s of [seed.A, seed.B, seed.F, seed.C]) await indexSession(s.id === seed.C.id ? "codex" : "claude", s.id, alpha, 1, s.title);
await indexSession("claude", seed.D.id, beta, 1, seed.D.title);

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { testRoute } = await import("./session-turn-refs-test-routes");

let uploadDelayMs = Number(process.env.PPM_TURN_REFS_UPLOAD_DELAY ?? 1500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An upload, late and uncached, so each image moves the layout when it lands. */
async function slowUpload(req: Request, server: unknown): Promise<Response> {
  await sleep(uploadDelayMs);
  const res = await app.fetch(req, server as never);
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  // Bytes, not `res.body`: reading a file response's body as a stream keeps its size in native memory.
  return new Response(await res.arrayBuffer(), { status: res.status, headers });
}

type SocketData = { type: "health" | "global" | "chat"; sessionId?: string; projectName?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__turn-test/")) {
      return testRoute(req, url, { seed, alpha, beta, setUploadDelay: (ms: number) => { uploadDelayMs = ms; } });
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
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (/^\/api\/project\/[^/]+\/chat\/uploads\//.test(url.pathname) && req.method === "GET") return slowUpload(req, instance);
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_TURN_REFS_WEB_DIR;
      if (!webDir) throw new Error("PPM_TURN_REFS_WEB_DIR required");
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
// What `src/server/index.ts` records once it listens: the MCP endpoint's URL is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Turn-refs fixture ready at http://127.0.0.1:${server.port}; scripted providers only.`);
