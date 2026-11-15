/** Served-production fixture for the secret vault's canary e2e (tests/e2e/vault-canary-e2e.mjs).
 * Adapted from db-tools-server and assistant-server. Requires an isolated home and PPM directory,
 * serves the scratch Vite bundle named by PPM_VAULT_WEB_DIR, keeps PPM's auth on with the token
 * the driver passes in PPM_VAULT_E2E_TOKEN, writes `ppm.log` the way the server does (at debug
 * level, so every line a run could log is written), and answers every turn with one scripted
 * provider, "claude", that can also run PPM Assistant sessions. No real SDK or CLI runs.
 *
 * The provider plays an AI that keeps everything it is given: every message and every tool result
 * it receives — and everything it says or sends — is appended to PPM_VAULT_TRANSCRIPT, a file
 * outside PPM_HOME that stands for Claude's own transcript. A scripted turn's ops:
 *  - `{ call, via, args }`: call one tool on PPM's session server (`via: "sessions"`: the vault
 *    tools, `send_to_session`) or the Assistant's own server (`via: "assistant"`: `notebook_add`),
 *    with the bearer token the turn was handed. A string `{{T1}}`/`{{T2}}`/`{{T3}}` in the args
 *    becomes the first value of that marker family the provider has received in this session;
 *  - `{ text }`: say something;
 *  - `{ repeat: true }`: say every marker value the session has received so far.
 * A posted script runs on the first turn whose message contains its `match`.
 *
 * With PPM_VAULT_FIXTURE_RESUME=1 it restarts on the same PPM_HOME (the provider's sessions come
 * back from PPM_VAULT_PROVIDER_STATE). The Assistant's Telegram bot points at the fake Bot API
 * (`assistant-telegram-fixture-setup.ts`), and ntfy at the fake ntfy the driver started
 * (PPM_VAULT_NTFY_URL, the fake's writer token).
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
const resuming = process.env.PPM_VAULT_FIXTURE_RESUME === "1";
if (!resuming && existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (resuming && !existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("A resumed fixture needs the database its first run created");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
const token = process.env.PPM_VAULT_E2E_TOKEN;
if (!token || token.length < 12) throw new Error("PPM_VAULT_E2E_TOKEN required");
// The provider's own storage stands for Claude's transcript: beside PPM_HOME, never inside it.
const transcriptPath = process.env.PPM_VAULT_TRANSCRIPT, statePath = process.env.PPM_VAULT_PROVIDER_STATE;
for (const p of [transcriptPath, statePath]) {
  if (!p || canonical(dirname(resolve(p))).startsWith(privatePpm) || !canonical(dirname(resolve(p))).startsWith(canonical(resolve(ppmHome, "..")))) {
    throw new Error("PPM_VAULT_TRANSCRIPT and PPM_VAULT_PROVIDER_STATE must name files beside, not inside, the isolated PPM_HOME");
  }
}
const ntfyUrl = process.env.PPM_VAULT_NTFY_URL;
if (!ntfyUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(ntfyUrl)) throw new Error("PPM_VAULT_NTFY_URL must name the loopback fake ntfy");
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

// Import services only after validating environment isolation. `ppm.log` as the server writes it:
// every logger line and every bare console call, through the same redaction.
const { installFileLogSink } = await import("../../../src/services/logger");
installFileLogSink({ echo: "console", routeConsole: true });
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: true, token });
configService.set("host", "127.0.0.1");
configService.set("port", port);
if (!resuming) {
  configService.set("ai", {
    default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false,
    providers: { claude: { type: "mock", permission_mode: "bypassPermissions" } },
  });
  await (await import("./answer-feature-intros")).answerFeatureIntrosAtStartup();
  // Settings → Tools, as the user turns them on: the vault's tools for ordinary chats (off by
  // default) and send_to_session, which the canary tries to smuggle a value through.
  const ai = configService.get("ai");
  configService.set("ai", {
    ...ai,
    ppm_tools: { ...(ai.ppm_tools ?? {}), vault_list: true, vault_read: true, vault_propose: true, send_to_session: true, session_status: true },
  } as never);
}
const { WRITER_TOKEN } = await import("../../helpers/fake-ntfy-server");
configService.set("ntfy", { server: ntfyUrl, topic: "ppm-vault-canary", token: WRITER_TOKEN } as never);
// The Assistant's bot on the fake Bot API, its chats connected, notifications sent at once, pushes kept.
const telegram = await (await import("./assistant-telegram-fixture-setup")).setupFakeTelegram({ resuming });

const { stringifyToolResultContent } = await import("../../../src/shared/tool-result-content");
const { stripSharedContext } = await import("../../../src/shared/provider-context");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { setSessionMetadata } = await import("../../../src/services/db.service");
const { CLAUDE_ASSISTANT_MCP_PREFIX } = await import("../../../src/shared/assistant-tool-names");
const { CLAUDE_SESSION_COLLAB_MCP_SERVER } = await import("../../../src/shared/session-collab");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;
type Session = import("../../../src/providers/provider.interface").Session;
type SessionInfo = import("../../../src/providers/provider.interface").SessionInfo;

type ScriptOp =
  | { call: string; via: "sessions" | "assistant"; args?: Record<string, unknown> }
  | { text: string }
  | { repeat: true };
interface Script { label: string; match: string; ops: ScriptOp[] }
interface CallRecord {
  label: string; sessionId: string; tool: string; via: string; assistant: boolean; handed: boolean;
  status?: number; isError?: boolean; text?: string; done?: boolean; ms?: number;
}
interface StoredSession extends Session { messages: ChatMessage[]; known: string[] }

const MARKER = /CANARY-T[123]-[A-Za-z0-9-]+/g;

const state: { sessions: Record<string, StoredSession> } = existsSync(statePath!)
  ? JSON.parse(readFileSync(statePath!, "utf8"))
  : { sessions: {} };
const saveState = () => writeFileSync(statePath!, JSON.stringify(state));
const scripts: Script[] = [];
const calls: CallRecord[] = [];
const turnsSeen: Array<{ label: string; sessionId: string; assistant: boolean; origin: string | null; at: number; done: boolean }> = [];

/** Everything the "model" receives or produces, appended as it happens. */
function transcript(sessionId: string, dir: "in" | "out", kind: string, text: string): void {
  appendFileSync(transcriptPath!, `${JSON.stringify({ at: new Date().toISOString(), sessionId, dir, kind, text })}\n`);
}

/** Remembers every marker value the session has been given, as a model keeps its context. */
function learn(s: StoredSession, text: string): void {
  for (const m of text.match(MARKER) ?? []) if (!s.known.includes(m)) s.known.push(m);
}

function fill(value: unknown, s: StoredSession): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(T[123])\}\}/g, (whole, family: string) => s.known.find((k) => k.startsWith(`CANARY-${family}-`)) ?? whole);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, s));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, s)]));
  return value;
}

interface LiveRun { queue: Array<{ message: string; opts?: SendOpts }>; wake?: () => void; abort: AbortController }

class VaultScriptedProvider {
  readonly id = "claude";
  readonly name = "Claude";
  readonly supportsAssistantSessions = true;
  /** Read by `chatService.getSession`. */
  readonly sessions = new Map<string, Session>();
  private live = new Map<string, LiveRun>();

  constructor() {
    for (const s of Object.values(state.sessions)) this.sessions.set(s.id, this.publicSession(s));
  }

  private publicSession(s: StoredSession): Session {
    const { messages: _m, known: _k, ...session } = s;
    return session;
  }

  async createSession(config: import("../../../src/providers/provider.interface").SessionConfig): Promise<Session> {
    const s: StoredSession = {
      id: crypto.randomUUID(), providerId: this.id, title: config.title ?? "New Chat",
      projectName: config.projectName, projectPath: config.projectPath, createdAt: new Date().toISOString(), messages: [], known: [],
    };
    state.sessions[s.id] = s;
    saveState();
    if (config.projectPath) setSessionMetadata(s.id, config.projectName, config.projectPath);
    this.sessions.set(s.id, this.publicSession(s));
    return this.publicSession(s);
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const s = state.sessions[sessionId];
    if (!s) throw new Error(`Session ${sessionId} not found`);
    this.sessions.set(s.id, this.publicSession(s));
    return this.publicSession(s);
  }

  private info(s: StoredSession): SessionInfo {
    return { id: s.id, providerId: s.providerId, title: s.title, projectName: s.projectName, createdAt: s.createdAt, updatedAt: s.messages.at(-1)?.timestamp ?? s.createdAt } as SessionInfo;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Object.values(state.sessions).map((s) => this.info(s));
  }

  async listSessionsByDir(dir: string): Promise<SessionInfo[]> {
    const fold = (p?: string) => (p ? resolve(p).toLowerCase() : "");
    return Object.values(state.sessions).filter((s) => fold(s.projectPath) === fold(dir)).map((s) => this.info(s));
  }

  async getSessionInfoById(sessionId: string, dir?: string): Promise<SessionInfo | null> {
    const s = state.sessions[sessionId];
    const fold = (p?: string) => (p ? resolve(p).toLowerCase() : "");
    return s && (!dir || fold(s.projectPath) === fold(dir)) ? this.info(s) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    delete state.sessions[sessionId];
    this.sessions.delete(sessionId);
    saveState();
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return state.sessions[sessionId]?.messages ?? [];
  }

  /** This provider never asks for an approval of its own; PPM's vault cards are PPM's. */
  resolveApproval(): void {}

  pushMessage(sessionId: string, message: string, opts?: SendOpts): void {
    const run = this.live.get(sessionId);
    if (!run) throw new Error(`No live run for ${sessionId}`);
    run.queue.push({ message, opts });
    run.wake?.();
  }

  hasStreamingSession(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  abortQuery(sessionId: string): void {
    const run = this.live.get(sessionId);
    if (!run) return;
    run.abort.abort();
    run.wake?.();
  }

  /** Like the CLI providers, one run per session that stays alive between turns. */
  async *sendMessage(sessionId: string, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    await this.resumeSession(sessionId);
    const run: LiveRun = { queue: [{ message, opts }], abort: new AbortController() };
    this.live.set(sessionId, run);
    try {
      yield { type: "system" as never, subtype: "init" } as never;
      while (!run.abort.signal.aborted) {
        const next = run.queue.shift();
        if (!next) {
          await new Promise<void>((wake) => { run.wake = wake; });
          run.wake = undefined;
          continue;
        }
        yield* this.turn(sessionId, run, next.message, next.opts);
      }
    } finally {
      this.live.delete(sessionId);
    }
  }

  private async *turn(sessionId: string, run: LiveRun, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    const s = state.sessions[sessionId]!;
    const assistant = opts?.assistantSession === true;
    const plain = stripSharedContext(message);
    if (s.title === "New Chat") s.title = plain.slice(0, 50);
    const now = () => new Date().toISOString();
    s.messages.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: now() });
    transcript(sessionId, "in", "message", `${opts?.sharedContext ?? ""}\n${message}`);
    learn(s, message);
    const index = scripts.findIndex((sc) => plain.includes(sc.match));
    const script = index >= 0 ? scripts.splice(index, 1)[0]! : { label: `unscripted ${plain.slice(0, 40)}`, match: "", ops: [] };
    const { getSessionTurnOrigin } = await import("../../../src/server/ws/chat");
    const seen = { label: script.label, sessionId, assistant, origin: getSessionTurnOrigin(sessionId) ?? null, at: Date.now(), done: false };
    turnsSeen.push(seen);
    const events: ChatEvent[] = [];
    const emit = (ev: ChatEvent) => { events.push(ev); return ev; };
    const said: string[] = [];

    for (const op of script.ops) {
      if (run.abort.signal.aborted) break;
      if ("text" in op) {
        said.push(op.text);
        yield emit({ type: "text", content: op.text });
        continue;
      }
      if ("repeat" in op) {
        const text = s.known.length ? `Everything I was given: ${s.known.join(" | ")}` : "I was given no values.";
        said.push(text);
        yield emit({ type: "text", content: text });
        continue;
      }
      const access = op.via === "assistant" ? opts?.assistantMcp : opts?.sessionCollabMcp;
      const args = fill(op.args ?? {}, s) as Record<string, unknown>;
      const record: CallRecord = { label: script.label, sessionId, tool: op.call, via: op.via, assistant, handed: !!access };
      calls.push(record);
      const toolUseId = `tu-${crypto.randomUUID()}`;
      const toolName = op.via === "assistant" ? `${CLAUDE_ASSISTANT_MCP_PREFIX}${op.call}` : `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__${op.call}`;
      transcript(sessionId, "out", "tool_use", JSON.stringify({ tool: toolName, args }));
      yield emit({ type: "tool_use", tool: toolName, input: args, toolUseId } as ChatEvent);
      const started = Date.now();
      if (!access) {
        record.isError = true;
        record.text = "No such tool available: the turn was not given that server";
      } else {
        try {
          const response = await fetch(access.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.call, arguments: args } }),
            signal: run.abort.signal,
          });
          record.status = response.status;
          const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
          record.isError = body?.result?.isError === true;
          record.text = (body?.result?.content ?? []).filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
        } catch (e) {
          record.isError = true;
          record.text = `call failed: ${(e as Error).message}`;
        }
      }
      record.ms = Date.now() - started;
      transcript(sessionId, "in", "tool_result", record.text ?? "");
      learn(s, record.text ?? "");
      record.done = true;
      yield emit({ type: "tool_result", output: stringifyToolResultContent([{ type: "text", text: record.text ?? "" }]), isError: record.isError, toolUseId } as ChatEvent);
    }
    if (run.abort.signal.aborted) {
      s.messages.push({ id: crypto.randomUUID(), role: "assistant", content: said.join("\n\n"), events, timestamp: now() } as ChatMessage);
      saveState();
      return;
    }
    const closing = `Turn "${script.label}" done.`;
    said.push(closing);
    yield emit({ type: "text", content: closing });
    transcript(sessionId, "out", "reply", said.join("\n\n"));
    s.messages.push({ id: crypto.randomUUID(), role: "assistant", content: said.join("\n\n"), events, timestamp: now() } as ChatMessage);
    saveState();
    seen.done = true;
    yield { type: "done", sessionId };
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new VaultScriptedProvider();
const providers = [claude];
providerRegistry.register(claude as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatSocketData, chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__vault-test/calls") return json({ calls, turns: turnsSeen });
  if (path === "/__vault-test/script" && req.method === "POST") {
    const body = await req.json() as Partial<Script>;
    if (typeof body.label !== "string" || typeof body.match !== "string" || !body.match || !Array.isArray(body.ops)) return json({ error: "label, match and ops required" }, 400);
    scripts.push({ label: body.label, match: body.match, ops: body.ops as ScriptOp[] });
    return json({ ok: true });
  }
  if (path.startsWith("/__vault-test/tg/")) {
    return (await telegram.route(req, path.slice("/__vault-test/tg/".length))) ?? json({ error: "unknown test route" }, 404);
  }
  // A restart, or the end of the run: the trace writer flushes on exit.
  if (path === "/__vault-test/exit" && req.method === "POST") {
    setTimeout(() => process.exit(0), 50);
    return json({ ok: true });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData = { type: "health" | "global" } | ReturnType<typeof chatSocketData>;
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__vault-test/")) return testRoute(req, url.pathname);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      const parts = url.pathname.split("/");
      if (parts[4] === "chat") data = chatSocketData(parts[5] ?? "", decodeURIComponent(parts[3] ?? ""), url.searchParams);
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname)) {
      return new Response("Disabled in fixture", { status: 403 });
    }
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_VAULT_WEB_DIR;
      if (!webDir) throw new Error("PPM_VAULT_WEB_DIR required");
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
// What `src/server/index.ts` records once it listens: the tools' URLs are built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
// The server's own hub startup: the Assistant's Telegram bridge and its vault/db notices.
const { startAssistantHub } = await import("../../../src/services/assistant-hub/assistant-hub-startup");
await startAssistantHub({ bridge: telegram.bridge });
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Vault fixture ready at http://127.0.0.1:${server.port}${resuming ? " (resumed)" : ""}; scripted provider only.`);
