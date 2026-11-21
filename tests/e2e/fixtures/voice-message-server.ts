/**
 * Served-production fixture for the voice-message e2e (tests/e2e/voice-message-e2e.mjs). One fresh,
 * isolated install per start: an empty PPM_HOME, one project (alpha), the scratch Vite bundle named
 * by PPM_VOICE_WEB_DIR, and a fake Whisper (`whisper/bin/whisper-cli`, written by the driver).
 *
 * The chat provider is scripted: it records every message PPM sends it (`/__voice-test/turns`) and
 * stands in for Claude Haiku's `completeOnce`, which the clean-up and the word learning call. The
 * clean-up answer can be switched to a failure (`POST /__voice-test/haiku {mode:"throw"}`), and
 * every Haiku call is listed (`/__voice-test/haiku-calls`). Nothing reaches a real model, and no
 * real PPM data is read.
 *
 * PPM_VOICE_MODE=telegram also starts the PPM Assistant's Telegram bridge against the fake Bot API
 * (tests/e2e/fixtures/fake-telegram-server.ts, started by the driver) through the same setup the
 * Assistant fixture uses; the Assistant's own provider is this scripted one.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
const webDir = process.env.PPM_VOICE_WEB_DIR;
const projectsDir = process.env.PPM_VOICE_PROJECTS;
if (!webDir || !projectsDir || !existsSync(projectsDir)) throw new Error("PPM_VOICE_WEB_DIR and PPM_VOICE_PROJECTS required");
const telegramMode = process.env.PPM_VOICE_MODE === "telegram";
// The voice intro's answer for this install: "on" (the feature), "off" (the feature stays off) or "" (not asked).
const voiceAnswer = process.env.PPM_VOICE_FEATURE ?? "on";
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

const alpha = join(projectsDir, "alpha");

// Import services only after validating environment isolation.
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("projects", [{ name: "alpha", path: alpha }] as never);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false, tab_tools: false,
  providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
} as never);
configService.set("assistant", { ...configService.get("assistant"), default_provider: "claude" } as never);

// The other introduced features are answered "off" (their tools stay off, as a user who declined
// them has them); the voice question is answered here, as the scenario needs it.
const { answerFeatureIntrosAtStartup } = await import("./answer-feature-intros");
await answerFeatureIntrosAtStartup("off");
const { answerFeatureIntro } = await import("../../../src/services/feature-intros.service");
const { FEATURE_INTROS } = await import("../../../src/shared/feature-intros");
const voiceIntro = FEATURE_INTROS.find((i) => i.setting === "voice_messages");
if (!voiceIntro) throw new Error("The voice-message introduction is not in FEATURE_INTROS");
if (voiceAnswer === "on" || voiceAnswer === "off") {
  const result = answerFeatureIntro(voiceIntro.id, voiceAnswer);
  if (!result.ok) throw new Error(`Could not answer the voice introduction: ${JSON.stringify(result)}`);
}

// PPM_VOICE_SELF_LEARNING=seed: self-learning on, with a week of learned words and one undone word,
// as a user who has had it on for a while would have them (the Settings pane's list has rows to show).
if (process.env.PPM_VOICE_SELF_LEARNING === "seed") {
  const { updateVoiceSettings, readVoiceSettings } = await import("../../../src/services/voice-message/voice-settings");
  updateVoiceSettings({ selfLearning: true });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const learned = [
    { word: "PPM", from: "BPM", at: hoursAgo(1), source: "cleanup", hits: 3, kind: "term" },
    { word: "Hono", from: "Hano", at: hoursAgo(3), source: "cleanup", hits: 2, kind: "term" },
    { word: "ra lệnh", from: "ta lệnh", at: hoursAgo(28), source: "cleanup", hits: 3, kind: "phrase" },
    { word: "ppm/53", from: "PPM 53", at: hoursAgo(30), source: "cleanup", hits: 2, kind: "term" },
    { word: "worktree", from: "work tree", at: hoursAgo(96), source: "edit" },
  ];
  const config = readVoiceSettings();
  const lists = { words: [], learned, blocked: [{ word: "Hà Nội", from: "Hano", at: hoursAgo(100) }] };
  configService.set("voice_message", { ...config, projects: { ...config.projects, alpha: lists, __assistant__: lists } } as never);
}

// ── Scripted chat provider, also the stand-in for Claude Haiku ──────────────────────────────
const { MockProvider } = await import("../../../src/providers/mock-provider");
const { providerRegistry } = await import("../../../src/providers/registry");
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;

/** What the Whisper stand-in prints, minus the Haiku clean-up: the misheard term stays for the user to fix. */
export const CLEANED_TEXT = "OK, giờ em sửa cái hô nô middleware cho Bun.serve đi.";
export const LEARN_PAIRS = [{ from: "hô nô", to: "Hono" }];

const turns: Array<{ sessionId: string; message: string; images: number; at: string }> = [];
const haikuCalls: Array<{ kind: "cleanup" | "learn" | "unknown"; ok: boolean; at: string }> = [];
let cleanupMode: "ok" | "throw" = "ok";

class VoiceTestProvider extends MockProvider {
  override id = "claude";
  override name = "Claude (voice test)";
  // The Assistant (and so its Telegram bridge) only takes a provider that declares these two.
  override supportsAssistantSessions = true;
  override supportsSharedContext = true;
  private history = new Map<string, ChatMessage[]>();

  override async *sendMessage(sessionId: string, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    turns.push({ sessionId, message, images: opts?.images?.length ?? 0, at: new Date().toISOString() });
    const reply = "Noted.";
    const history = this.history.get(sessionId) ?? [];
    history.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: new Date().toISOString() });
    history.push({ id: crypto.randomUUID(), role: "assistant", content: reply, timestamp: new Date().toISOString() });
    this.history.set(sessionId, history);
    yield { type: "text", content: reply };
    yield { type: "done", sessionId };
  }

  override async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.history.get(sessionId) ?? [];
  }

  /** Haiku's two prompts are told apart by their system prompts; anything else is an unexpected call. */
  override async completeOnce(input: { prompt: string; systemPrompt?: string }): Promise<{ text: string; costUsd: number; inputTokens: number; outputTokens: number }> {
    const system = input.systemPrompt ?? "";
    const at = new Date().toISOString();
    const usage = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
    if (system.includes("clean a speech-to-text transcript")) {
      const ok = cleanupMode === "ok";
      haikuCalls.push({ kind: "cleanup", ok, at });
      if (!ok) throw new Error("Claude is not answering in this test");
      return { text: JSON.stringify({ text: CLEANED_TEXT }), ...usage };
    }
    if (system.includes("corrected a speech-to-text transcript")) {
      haikuCalls.push({ kind: "learn", ok: true, at });
      return { text: JSON.stringify({ pairs: LEARN_PAIRS }), ...usage };
    }
    haikuCalls.push({ kind: "unknown", ok: false, at });
    throw new Error("Unexpected prompt in the voice test");
  }
}
const provider = new VoiceTestProvider();
// Replaces the built-in Claude provider under the same id: every chat, Haiku call and Assistant turn is this one.
providerRegistry.register(provider);

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  if (path === "/turns") return json({ turns });
  if (path === "/haiku-calls") return json({ calls: haikuCalls });
  if (path === "/haiku" && req.method === "POST") {
    cleanupMode = body.mode === "throw" ? "throw" : "ok";
    return json({ mode: cleanupMode });
  }
  if (path === "/voice-state") return json({ cleanupMode, enabled: configService.get("voice_message")?.enabled ?? null });
  if (path === "/voice-enabled" && req.method === "POST") {
    const { updateVoiceSettings } = await import("../../../src/services/voice-message/voice-settings");
    return json({ enabled: updateVoiceSettings({ enabled: body.enabled === true }).enabled ?? null });
  }
  return json({ error: `unknown test route ${path}` }, 404);
}

// Telegram: the bridge and its fake Bot API, set up as the Assistant fixture sets them up.
let telegram: Awaited<ReturnType<(typeof import("./assistant-telegram-fixture-setup"))["setupFakeTelegram"]>> | null = null;
if (telegramMode) {
  const { setupFakeTelegram } = await import("./assistant-telegram-fixture-setup");
  telegram = await setupFakeTelegram({ resuming: false });
}

type SocketData = { type: "health" | "global" | "chat" | "terminal"; sessionId?: string; projectName?: string; id?: string; cwd?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__voice-test/")) return testRoute(req, url.pathname.slice("/__voice-test".length));
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName: decodeURIComponent(parts[3] ?? "") };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
    }
    if (!url.pathname.startsWith("/api/")) {
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
// What `src/server/index.ts` records once it listens: the Assistant's and tab tools' URLs are built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
// The same hub startup the server runs; the Telegram bridge starts only when this install has a bot.
const { startAssistantHub } = await import("../../../src/services/assistant-hub/assistant-hub-startup");
await startAssistantHub(telegram ? { bridge: telegram.bridge } : {});
function shutdown() {
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Voice-message fixture ready at http://127.0.0.1:${server.port} (${telegramMode ? "telegram" : "web"}); scripted provider only.`);
