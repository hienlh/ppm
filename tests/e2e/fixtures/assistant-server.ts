/** Served-production fixture for the PPM Assistant e2e (tests/e2e/assistant-e2e.mjs). Adapted from
 * tab-tools-server. Requires an isolated home and PPM directory, serves the scratch Vite bundle
 * named by PPM_ASSISTANT_WEB_DIR, and answers every turn with a scripted provider — registered as
 * both "claude" and "codex" — that calls the real `/api/assistant-mcp` endpoint the way the CLIs
 * do, with the bearer token the turn was handed. No real SDK or CLI runs.
 *
 * What a scripted turn can do (each op of the script the test posted):
 *  - `mcp`: call one of the Assistant's tools and report its answer as the tool's result;
 *  - `builtin`: a provider-side tool (WebFetch, Read, Bash). In an Assistant session the decision
 *    is the real Claude policy, `assistantToolDecision`, which the Claude provider's PreToolUse
 *    hook calls; "ask" puts a provider card on the chat and waits for the answer, as the hook's
 *    `waitForApproval` does. In an ordinary chat it asks unless the chat runs in bypass mode;
 *  - `text`: say something (markdown included).
 * The "codex" provider renames each new session on its first turn (`session_migrated`), as Codex
 * does when its thread id replaces PPM's draft id. Sessions and transcripts are kept in a JSON
 * file (PPM_ASSISTANT_FIXTURE_STATE) and Claude's are also written where the CLI writes them, so
 * a restarted fixture (PPM_ASSISTANT_FIXTURE_RESUME=1, same PPM_HOME) still knows every chat.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const canonical = (path: string) => realpathSync(path).replace(/\\/g, "/").toLowerCase();
const ppmHome = process.env.PPM_HOME, sandboxHome = process.env.HOME;
const profile = process.env.USERPROFILE, realHomePath = process.env.PPM_HTML_TEST_REAL_HOME;
if (!ppmHome || !sandboxHome || !profile || !realHomePath) throw new Error("Fixture requires isolated PPM_HOME, HOME, USERPROFILE and the parent's real home.");
const realHome = canonical(realHomePath), privateHome = canonical(sandboxHome), privatePpm = canonical(ppmHome);
if (privateHome === realHome || canonical(profile) !== privateHome || privatePpm === realHome ||
    privatePpm === `${realHome}/.ppm` || privatePpm.startsWith(`${realHome}/.ppm/`)) {
  throw new Error("Refusing the production home or PPM directory");
}
const resuming = process.env.PPM_ASSISTANT_FIXTURE_RESUME === "1";
if (!resuming && existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("Fixture requires an empty PPM_HOME");
if (resuming && !existsSync(resolve(ppmHome, "ppm.db"))) throw new Error("A resumed fixture needs the database its first run created");
if (process.argv.includes("__serve__") || process.env.PPM_ALLOW_PROD_DB) throw new Error("Production flags are forbidden");
const port = Number(process.env.PPM_HTML_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid fixture port");
const statePath = process.env.PPM_ASSISTANT_FIXTURE_STATE;
if (!statePath || !canonical(dirname(resolve(statePath))).startsWith(canonical(resolve(ppmHome, "..")))) {
  throw new Error("PPM_ASSISTANT_FIXTURE_STATE must name a file beside the isolated PPM_HOME");
}
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];
process.env.CLAUDE_CONFIG_DIR = resolve(sandboxHome, ".claude");
process.env.CODEX_HOME = resolve(sandboxHome, ".codex");
process.env.SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

// Import services only after validating environment isolation.
const { APPROVAL_TIMEOUT_ENV, approvalTimeoutMs } = await import("../../../src/services/assistant-mcp/assistant-approval-broker");
if (!process.env[APPROVAL_TIMEOUT_ENV]) throw new Error(`${APPROVAL_TIMEOUT_ENV} must be set: no test waits ten minutes`);
const { configService } = await import("../../../src/services/config.service");
configService.load();
configService.set("auth", { ...configService.get("auth"), enabled: false });
configService.set("host", "127.0.0.1");
configService.set("port", port);
configService.set("ai", {
  default_provider: "claude", new_chat_provider_mode: "default", share_provider_context: false, tab_tools: true,
  providers: {
    claude: { type: "mock", permission_mode: "bypassPermissions" },
    codex: { type: "mock", permission_mode: "bypassPermissions" },
  },
});

const { stringifyToolResultContent } = await import("../../../src/shared/tool-result-content");
const { setServerListenAddress } = await import("../../../src/services/server-listen-address");
const { assistantToolDecision } = await import("../../../src/services/assistant/assistant-tool-policy");
const { setSessionMetadata, setSessionProvider } = await import("../../../src/services/db.service");
const { CODEX_ASSISTANT_MCP_SERVER, CLAUDE_ASSISTANT_MCP_PREFIX } = await import("../../../src/shared/assistant-tool-names");
type SendOpts = import("../../../src/providers/provider.interface").SendMessageOpts;
type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;
type Session = import("../../../src/providers/provider.interface").Session;
type SessionInfo = import("../../../src/providers/provider.interface").SessionInfo;

type ScriptOp =
  | { mcp: string; args?: Record<string, unknown>; wait?: number }
  | { builtin: "WebFetch" | "Read" | "Bash"; input: Record<string, unknown> }
  | { text: string };
/** One posted script: the ops of one turn, and the words that turn ends with. */
interface Script { label: string; ops: ScriptOp[] }

interface CallRecord {
  label: string;
  sessionId: string;
  provider: string;
  op: ScriptOp;
  /** The turn ran as an Assistant session (the chat service set `assistantSession`). */
  assistant: boolean;
  /** The turn carried the Assistant's MCP access. */
  handed: boolean;
  status?: number;
  isError?: boolean;
  text?: string;
  ms?: number;
  /** For a builtin: the policy's decision, and the card's answer when it asked. */
  decision?: "allow" | "ask";
  approved?: boolean;
  done?: boolean;
}

interface StoredSession extends Session { messages: ChatMessage[] }

/** Everything the scripted provider knows, kept on disk so a restarted fixture knows it too. */
const state: { sessions: Record<string, StoredSession> } = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { sessions: {} };
const saveState = () => writeFileSync(statePath, JSON.stringify(state));

/** Scripts waiting for a turn: by session id, or "*" for whichever turn comes next. */
const scripts = new Map<string, Script[]>();
const calls: CallRecord[] = [];
const turnsSeen: Array<{ label: string; sessionId: string; provider: string; message: string; assistant: boolean }> = [];
const pendingApprovals = new Map<string, (approved: boolean) => void>();

function takeScript(ids: string[]): Script | null {
  for (const id of [...ids, "*"]) {
    const queue = scripts.get(id);
    if (queue?.length) return queue.shift()!;
  }
  return null;
}

/** Same encoding the CLI uses for a project's transcript folder. */
const claudeSlug = (projectPath: string) => projectPath.replace(/[/\\:.]/g, "-");

/** A follow-up waiting for the session's live run, and how that run is told to stop. */
interface LiveRun { queue: Array<{ message: string; opts?: SendOpts }>; wake?: () => void; abort: AbortController; cards: Set<string> }

class ScriptedProvider {
  readonly supportsAssistantSessions = true;
  /** Read by `chatService.getSession` (`(provider as any).sessions`). */
  readonly sessions = new Map<string, Session>();
  private live = new Map<string, LiveRun>();

  constructor(public id: "claude" | "codex", public name: string) {
    for (const s of Object.values(state.sessions)) if (s.providerId === id) this.sessions.set(s.id, this.publicSession(s));
  }

  private publicSession(s: StoredSession): Session {
    const { messages: _m, ...session } = s;
    return session;
  }

  private stored(id: string): StoredSession | undefined {
    const s = state.sessions[id];
    return s && s.providerId === this.id ? s : undefined;
  }

  async createSession(config: import("../../../src/providers/provider.interface").SessionConfig): Promise<Session> {
    const s: StoredSession = {
      id: crypto.randomUUID(), providerId: this.id, title: config.title ?? "New Chat",
      projectName: config.projectName, projectPath: config.projectPath, createdAt: new Date().toISOString(), messages: [],
    };
    state.sessions[s.id] = s;
    saveState();
    this.sessions.set(s.id, this.publicSession(s));
    return this.publicSession(s);
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.stored(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    this.sessions.set(s.id, this.publicSession(s));
    return this.publicSession(s);
  }

  private info(s: StoredSession): SessionInfo {
    return { id: s.id, providerId: s.providerId, title: s.title, projectName: s.projectName, createdAt: s.createdAt, updatedAt: s.messages.at(-1)?.timestamp ?? s.createdAt } as SessionInfo;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Object.values(state.sessions).filter((s) => s.providerId === this.id).map((s) => this.info(s));
  }

  /** By working directory, as both CLIs list a project's sessions. */
  async listSessionsByDir(dir: string): Promise<SessionInfo[]> {
    const fold = (p?: string) => (p ? resolve(p).toLowerCase() : "");
    return Object.values(state.sessions)
      .filter((s) => s.providerId === this.id && fold(s.projectPath) === fold(dir))
      .map((s) => this.info(s));
  }

  async deleteSession(sessionId: string): Promise<void> {
    delete state.sessions[sessionId];
    this.sessions.delete(sessionId);
    saveState();
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.stored(sessionId)?.messages ?? [];
  }

  resolveApproval(requestId: string, approved: boolean): void {
    const settle = pendingApprovals.get(requestId);
    pendingApprovals.delete(requestId);
    settle?.(approved);
  }

  /** A follow-up typed while the session's run is alive: it runs as that run's next turn. */
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
    const run: LiveRun = { queue: [{ message, opts }], abort: new AbortController(), cards: new Set() };
    const ids = [sessionId];
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
        yield* this.turn(ids, run, next.message, next.opts);
      }
    } finally {
      for (const id of ids) this.live.delete(id);
      // A run that ends leaves no card waiting, as the Claude provider's session cleanup does.
      for (const requestId of run.cards) this.resolveApproval(requestId, false);
    }
  }

  private async *turn(ids: string[], run: LiveRun, message: string, opts?: SendOpts): AsyncIterable<ChatEvent> {
    let sessionId = ids.at(-1)!;
    let s = this.stored(sessionId)!;
    const assistant = opts?.assistantSession === true;
    // Codex replaces PPM's draft id with its thread id during a new chat's first turn.
    if (this.id === "codex" && s.messages.length === 0) {
      const threadId = crypto.randomUUID();
      setSessionMetadata(threadId, s.projectName, s.projectPath);
      setSessionProvider(threadId, this.id);
      delete state.sessions[s.id];
      s = { ...s, id: threadId };
      state.sessions[threadId] = s;
      this.sessions.set(threadId, this.publicSession(s));
      ids.push(threadId);
      this.live.set(threadId, run);
      yield { type: "session_migrated", oldSessionId: sessionId, newSessionId: threadId } as ChatEvent;
      sessionId = threadId;
    }
    if (s.title === "New Chat") s.title = message.slice(0, 50);
    const now = () => new Date().toISOString();
    s.messages.push({ id: crypto.randomUUID(), role: "user", content: message, timestamp: now() });
    const script = takeScript(ids) ?? { label: `unscripted ${message.slice(0, 40)}`, ops: [] };
    turnsSeen.push({ label: script.label, sessionId, provider: this.id, message, assistant });
    const access = opts?.assistantMcp;
    const events: ChatEvent[] = [];
    const emit = (ev: ChatEvent) => { events.push(ev); return ev; };

    for (const op of script.ops) {
      if (run.abort.signal.aborted) break;
      if ("text" in op) { yield emit({ type: "text", content: op.text }); continue; }
      const record: CallRecord = { label: script.label, sessionId, provider: this.id, op, assistant, handed: !!access };
      calls.push(record);
      const toolUseId = `tu-${crypto.randomUUID()}`;
      if ("builtin" in op) {
        yield* this.builtin(record, op, toolUseId, run, s, opts, emit);
        continue;
      }
      const args = op.args ?? {};
      yield emit((this.id === "codex"
        ? { type: "tool_use", tool: `${CODEX_ASSISTANT_MCP_SERVER}:${op.mcp}`, input: { server: CODEX_ASSISTANT_MCP_SERVER, tool: op.mcp, arguments: args }, toolUseId }
        : { type: "tool_use", tool: `${CLAUDE_ASSISTANT_MCP_PREFIX}${op.mcp}`, input: args, toolUseId }) as ChatEvent);
      if (!access) {
        record.text = "no assistant tools";
        record.done = true;
        yield emit({ type: "tool_result", output: "No such tool available: the turn was not given the Assistant's tools", isError: true, toolUseId } as ChatEvent);
        continue;
      }
      if (op.wait) await new Promise((r) => setTimeout(r, op.wait));
      const started = Date.now();
      try {
        const response = await fetch(access.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${access.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: op.mcp, arguments: args } }),
          signal: run.abort.signal,
        });
        record.status = response.status;
        const body = await response.json().catch(() => null) as { result?: { content?: Array<Record<string, unknown>>; isError?: boolean } } | null;
        const content = body?.result?.content ?? [];
        record.isError = body?.result?.isError === true;
        record.text = content.filter((b) => b.type === "text").map((b) => String(b.text)).join("\n");
      } catch (e) {
        record.isError = true;
        record.text = `call failed: ${(e as Error).message}`;
      }
      record.ms = Date.now() - started;
      record.done = true;
      yield emit({ type: "tool_result", output: stringifyToolResultContent([{ type: "text", text: record.text ?? "" }]), isError: record.isError, toolUseId } as ChatEvent);
    }
    const text = `Turn "${script.label}" done.`;
    yield emit({ type: "text", content: text });
    s.messages.push({ id: crypto.randomUUID(), role: "assistant", content: events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("\n\n"), events, timestamp: now() } as ChatMessage);
    saveState();
    if (this.id === "claude" && s.projectPath) this.writeTranscript(s, message, text);
    yield { type: "done", sessionId };
  }

  /** A provider-side tool, decided the way the Claude provider's PreToolUse hook decides it. */
  private async *builtin(
    record: CallRecord, op: Extract<ScriptOp, { builtin: string }>, toolUseId: string, run: LiveRun,
    s: StoredSession, opts: SendOpts | undefined, emit: (ev: ChatEvent) => ChatEvent,
  ): AsyncIterable<ChatEvent> {
    yield emit({ type: "tool_use", tool: op.builtin, input: op.input, toolUseId } as ChatEvent);
    const decision = opts?.assistantSession
      ? assistantToolDecision(op.builtin, op.input, { cwd: s.projectPath, projectRoots: configService.get("projects").map((p) => p.path) })
      : opts?.permissionMode === "bypassPermissions" || op.builtin === "Read" ? "allow" : "ask";
    record.decision = decision;
    let approved = decision === "allow";
    if (decision === "ask") {
      const requestId = crypto.randomUUID();
      run.cards.add(requestId);
      const answer = new Promise<boolean>((settle) => pendingApprovals.set(requestId, settle));
      yield { type: "approval_request", requestId, tool: op.builtin, input: op.input } as ChatEvent;
      approved = await answer;
      run.cards.delete(requestId);
      record.approved = approved;
    }
    record.isError = !approved;
    record.text = approved ? `${op.builtin} ran` : "User denied tool execution";
    record.done = true;
    yield emit({ type: "tool_result", output: record.text, isError: !approved, toolUseId } as ChatEvent);
  }

  /** Where the Claude CLI keeps a session's transcript, which PPM's ownership checks look for. */
  private writeTranscript(s: StoredSession, user: string, reply: string): void {
    const dir = join(homedir(), ".claude", "projects", claudeSlug(s.projectPath!));
    mkdirSync(dir, { recursive: true });
    const line = (role: "user" | "assistant", content: string) => JSON.stringify({
      type: role, sessionId: s.id, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: s.projectPath,
      message: { role, content: role === "user" ? content : [{ type: "text", text: content }] },
    });
    appendFileSync(join(dir, `${s.id}.jsonl`), `${line("user", user)}\n${line("assistant", reply)}\n`);
  }
}

const { providerRegistry } = await import("../../../src/providers/registry");
const claude = new ScriptedProvider("claude", "Claude");
const codex = new ScriptedProvider("codex", "Codex");
const providers = [claude, codex];
for (const p of providers) providerRegistry.register(p as never);
// Keep the imported production provider instances unreachable, including aggregate routes.
providerRegistry.get = ((id: string) => providers.find((p) => p.id === id)) as typeof providerRegistry.get;
providerRegistry.list = () => providers.map((p) => ({ id: p.id, name: p.name }));
providerRegistry.listAll = providerRegistry.list;
providerRegistry.getDefault = (() => claude) as typeof providerRegistry.getDefault;

const { app } = await import("../../../src/server/index");
const { chatWebSocket } = await import("../../../src/server/ws/chat");
const { globalWebSocket } = await import("../../../src/server/ws/global");
const { terminalWebSocket } = await import("../../../src/server/ws/terminal");

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === "/__assistant-test/calls") return json({ calls, turns: turnsSeen, pendingProviderApprovals: pendingApprovals.size });
  if (path === "/__assistant-test/script" && req.method === "POST") {
    const body = await req.json() as { sessionId?: string; label?: unknown; ops?: unknown };
    if (typeof body.label !== "string" || !Array.isArray(body.ops)) return json({ error: "label and ops required" }, 400);
    const key = body.sessionId ?? "*";
    scripts.set(key, [...(scripts.get(key) ?? []), { label: body.label, ops: body.ops as ScriptOp[] }]);
    return json({ ok: true });
  }
  // Shortens or restores the approval wait through the broker's own environment override; the
  // broker reads it each time it asks.
  if (path === "/__assistant-test/approval-timeout" && req.method === "POST") {
    const { ms } = await req.json() as { ms: number };
    process.env[APPROVAL_TIMEOUT_ENV] = String(ms);
    return json({ ok: true, effective: approvalTimeoutMs() });
  }
  // A restart, or the end of the run: the shells this process started go with it rather than
  // outliving it, then the process ends without any of its pending calls answering.
  if (path === "/__assistant-test/exit" && req.method === "POST") {
    const { terminalService } = await import("../../../src/services/terminal.service");
    for (const t of terminalService.list()) { try { terminalService.kill(t.id); } catch { /* already gone */ } }
    setTimeout(() => process.exit(0), 50);
    return json({ ok: true });
  }
  return json({ error: "unknown test route" }, 404);
}

type SocketData =
  | { type: "health" | "global" }
  | { type: "chat"; sessionId: string; projectName: string; providerHint?: string }
  | { type: "terminal"; id: string; projectName: string; cwd?: string };
const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", port,
  fetch(req, instance) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/__assistant-test/")) return testRoute(req, url.pathname);
    let data: SocketData | undefined;
    if (url.pathname === "/ws/health") data = { type: "health" };
    else if (url.pathname === "/ws/global") data = { type: "global" };
    else if (url.pathname.startsWith("/ws/project/")) {
      // As `src/server/index.ts` routes them.
      const parts = url.pathname.split("/");
      const projectName = decodeURIComponent(parts[3] ?? "");
      if (parts[4] === "chat") data = { type: "chat", sessionId: parts[5] ?? "", projectName, providerHint: url.searchParams.get("providerId") ?? undefined };
      else if (parts[4] === "terminal") data = { type: "terminal", id: parts[5] ?? "", projectName, cwd: url.searchParams.get("cwd") ?? undefined };
    }
    if (data) return instance.upgrade(req, { data }) ? undefined : new Response("Upgrade failed", { status: 400 });
    if (url.pathname.startsWith("/ws/")) return new Response("Socket disabled in fixture", { status: 404 });
    if (/^\/api\/(?:accounts|tunnels?|preview|upgrade|codex-accounts|proxy|mcp|remote-desktop)(?:\/|$)/.test(url.pathname) ||
        /^\/api\/settings\/(?:telegram|clawbot|ppmbot)/.test(url.pathname)) return new Response("Disabled in fixture", { status: 403 });
    if (!url.pathname.startsWith("/api/")) {
      const webDir = process.env.PPM_ASSISTANT_WEB_DIR;
      if (!webDir) throw new Error("PPM_ASSISTANT_WEB_DIR required");
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
      else if (ws.data.type === "terminal") terminalWebSocket.open(ws as never);
    },
    message(ws, message) {
      if (ws.data.type === "chat") void chatWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "global") globalWebSocket.message(ws as never, message as string);
      else if (ws.data.type === "terminal") void terminalWebSocket.message(ws as never, message as never);
      else ws.send("pong");
    },
    close(ws) {
      if (ws.data.type === "chat") chatWebSocket.close(ws as never);
      else if (ws.data.type === "global") globalWebSocket.close(ws as never);
      else if (ws.data.type === "terminal") terminalWebSocket.close(ws as never);
    },
  },
});
// What `src/server/index.ts` records once it listens: the Assistant's tool URL is built from it.
setServerListenAddress(server.port ?? port, "127.0.0.1");
function shutdown() { server.stop(true); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(`Assistant fixture ready at http://127.0.0.1:${server.port}${resuming ? " (resumed)" : ""}; scripted providers only.`);
