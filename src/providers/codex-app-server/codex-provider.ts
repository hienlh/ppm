import type {
  AIProvider,
  Session,
  SessionConfig,
  SessionInfo,
  ChatEvent,
  ChatMessage,
  ModelOption,
  SendMessageOpts,
  UsageInfo,
} from "../provider.interface.ts";
import { configService } from "../../services/config.service.ts";
import { setSessionMetadata, getSessionProjectPath, setSessionProvider, setSessionCodexAccount } from "../../services/db.service.ts";
import { resolveCodexAccountForSession } from "../../services/codex-account.service.ts";
import { killProcessTree } from "../../services/windows-process-tree.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexJsonRpcClient } from "./codex-jsonrpc-client.ts";
import { permissionModeToCodex, type CodexPermission } from "./codex-permission-map.ts";
import { mapCodexEvent } from "./codex-event-mapper.ts";
import { decisionFor, isApprovalMethod, type ApprovalMethod } from "./codex-approval-decision.ts";
import { parseModelList } from "./codex-model-parser.ts";
import { fetchCodexUsage } from "./codex-usage-fetch.ts";
import { redactTruncate } from "./codex-redact.ts";
import {
  listCodexRollouts,
  findRolloutByThreadId,
  getRolloutMessages,
} from "./codex-history.ts";
import type {
  ModelListResponse,
  ServerRequest,
  JsonRpcNotification,
  ToolRequestUserInputResponse,
  Thread,
} from "./codex-protocol.ts";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };
const MODELS_CACHE_TTL = 5 * 60 * 1000;

interface PendingApproval {
  codexId: number | string;
  method: string;
  questions?: unknown;
}

interface LiveSession {
  client: CodexJsonRpcClient;
  threadId: string | null;
  cwd: string;
  channel: EventChannel;
  permission: CodexPermission;
  model?: string;
  pendingApprovals: Map<string, PendingApproval>;
  answeredCodexIds: Set<number | string>;
  /** Rollout history snapshot at connect — lets live message ids continue the
   *  stable `rollout-N` numbering instead of ephemeral uuids, so fork anchors
   *  resolved against either the live view or the persisted file always match. */
  history: ChatMessage[];
  transcript: ChatMessage[];
  currentAssistant: string;
  currentEvents: ChatEvent[];
  compactRequested?: boolean;
}

interface EventChannel {
  push(ev: ChatEvent): void;
  done(): void;
  iterator: AsyncGenerator<ChatEvent, void, undefined>;
}

/** Next stable `rollout-N` id for a live message. Counts existing rollout-prefixed
 *  entries (history + live transcript) so numbering continues the persisted file's
 *  sequence and stays aligned even when a non-rollout compact-summary entry is present. */
function nextRolloutId(live: LiveSession): string {
  const isRollout = (m: ChatMessage) => typeof m.id === "string" && m.id.startsWith("rollout-");
  const n = live.history.filter(isRollout).length + live.transcript.filter(isRollout).length;
  return `rollout-${n}`;
}

/** Unbounded async channel: producers push ChatEvents, the generator drains them. */
function createEventChannel(): EventChannel {
  const queue: ChatEvent[] = [];
  let resolve: ((ev: ChatEvent | null) => void) | null = null;
  let isDone = false;

  async function* gen(): AsyncGenerator<ChatEvent, void, undefined> {
    while (!isDone || queue.length > 0) {
      if (queue.length > 0) { yield queue.shift()!; continue; }
      const ev = await new Promise<ChatEvent | null>((r) => { resolve = r; });
      if (ev) yield ev;
    }
  }

  return {
    push(ev) {
      if (isDone) return;
      if (resolve) { const r = resolve; resolve = null; r(ev); }
      else queue.push(ev);
    },
    done() {
      isDone = true;
      if (resolve) { const r = resolve; resolve = null; r(null); }
    },
    iterator: gen(),
  };
}

/**
 * Drop a model id that isn't a codex model. PPM's per-session model can fall back
 * to the global Claude default (e.g. `claude-opus-4-8`), which codex rejects
 * ("model is not supported when using Codex"). When unsure, send no model and let
 * codex pick its own default.
 */
function codexModel(model?: string): string | undefined {
  if (!model || /^claude/i.test(model)) return undefined;
  return model;
}

function extractThreadId(result: unknown): string | null {
  const r = result as { thread?: Thread; threadId?: string; id?: string } | undefined;
  return r?.thread?.id ?? r?.threadId ?? r?.id ?? null;
}

/** Human label for an approval prompt (dormant in MVP under default bypass). */
function approvalToolLabel(method: string, params: unknown): string {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  if (method.includes("commandExecution") || method === "execCommandApproval") return "Bash";
  if (method.includes("fileChange") || method === "applyPatchApproval") return "Edit";
  if (method === "item/tool/requestUserInput") return "AskUserQuestion";
  return String(p.tool ?? "Tool");
}

function buildUserInputResponse(questions: unknown, data: unknown): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse["answers"] = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      answers[k] = { answers: Array.isArray(v) ? v.map(String) : [String(v)] };
    }
    return { answers };
  }
  const arr = Array.isArray(data) ? data : data != null ? [data] : [];
  const qs = Array.isArray(questions) ? questions : [];
  qs.forEach((q, i) => {
    const qid = (q && typeof q === "object" && ((q as any).id ?? (q as any).questionId)) || String(i);
    const a = arr[i];
    answers[qid] = { answers: a != null ? [String(a)] : [] };
  });
  return { answers };
}

/**
 * Codex provider — implements AIProvider directly (mirrors claude-agent-sdk),
 * driving `codex app-server` over JSON-RPC. Per-session live subprocess map;
 * multi-turn via a single generator multiplexing sequential turns over one
 * notification stream. Token-by-token streaming is the load-bearing capability.
 */
export class CodexAppServerProvider implements AIProvider {
  readonly id = "codex";
  readonly name = "Codex";

  private sessions = new Map<string, Session>();
  private live = new Map<string, LiveSession>();
  private modelsCache: { models: ModelOption[]; expiry: number } | null = null;

  private get config() {
    try { return configService.get("ai").providers["codex"] ?? null; } catch { return null; }
  }

  // ── Session lifecycle ──
  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      providerId: this.id,
      title: config.title ?? "New Chat",
      projectName: config.projectName,
      projectPath: config.projectPath,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    if (config.projectPath) setSessionMetadata(id, config.projectName, config.projectPath);
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session: Session = {
      id: sessionId,
      providerId: this.id,
      title: "Resumed Chat",
      projectPath: getSessionProjectPath(sessionId) ?? undefined,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id, providerId: s.providerId, title: s.title,
      projectName: s.projectName, createdAt: s.createdAt,
    }));
  }

  async listSessionsByDir(dir: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]> {
    const sessions = listCodexRollouts(CODEX_SESSIONS_DIR, dir, this.id, opts);
    // Backfill provider ownership so reopening a pre-existing codex thread routes
    // to codex (not the default provider) even after a restart.
    for (const s of sessions) { try { setSessionProvider(s.id, this.id); } catch { /* non-fatal */ } }
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.abortQuery(sessionId, "delete");
    this.sessions.delete(sessionId);
  }

  // ── Streaming (multi-turn) ──
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    let live = this.live.get(sessionId);
    if (!live) {
      try {
        live = await this.connect(sessionId, opts);
      } catch (err) {
        yield { type: "error", message: redactTruncate((err as Error)?.message ?? String(err), 512) };
        yield { type: "done", sessionId, resultSubtype: "error_during_execution" };
        return;
      }
    }
    this.startTurn(live, message, opts);
    for await (const ev of live.channel.iterator) {
      yield ev;
    }
  }

  /** Follow-up turn on the live session (turn 2+). Fire-and-forget per WS contract. */
  pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): void {
    const live = this.live.get(sessionId);
    if (!live || live.client.isClosed) return;
    this.startTurn(live, content, opts);
  }

  private startTurn(live: LiveSession, message: string, opts?: SendMessageOpts): void {
    if (!live.threadId) return;
    // `/compact` → trigger codex's real compaction (thread/compact/start), not a text turn.
    // Completion is surfaced on the `thread/compacted` notification (handleNotification).
    if (message.trim() === "/compact") {
      live.compactRequested = true;
      live.client.request("thread/compact/start", { threadId: live.threadId }).catch((err) => {
        live.compactRequested = false;
        if (!live.client.isClosed) live.channel.push({ type: "error", message: redactTruncate((err as Error)?.message ?? String(err), 256) });
        live.channel.push({ type: "done", sessionId: live.threadId ?? "", resultSubtype: "error_during_execution" });
      });
      return;
    }
    live.transcript.push({ id: nextRolloutId(live), role: "user", content: message, timestamp: new Date().toISOString() });
    live.currentAssistant = "";
    live.currentEvents = [];
    const input = [{ type: "text" as const, text: message, text_elements: [] }];
    const turnModel = codexModel(opts?.model);
    live.client.request("turn/start", {
      threadId: live.threadId,
      input,
      ...(turnModel ? { model: turnModel } : {}),
    }).catch((err) => {
      if (!live.client.isClosed) live.channel.push({ type: "error", message: redactTruncate((err as Error)?.message ?? String(err), 256) });
    });
  }

  private async connect(sessionId: string, opts?: SendMessageOpts): Promise<LiveSession> {
    const meta = this.sessions.get(sessionId);
    const cwd = meta?.projectPath || getSessionProjectPath(sessionId) || process.cwd();
    const permission = permissionModeToCodex(opts?.permissionMode ?? this.config?.permission_mode);
    const model = codexModel(opts?.model ?? this.config?.model);

    const client = new CodexJsonRpcClient();
    const channel = createEventChannel();
    const live: LiveSession = {
      client, threadId: null, cwd, channel, permission, model,
      pendingApprovals: new Map(), answeredCodexIds: new Set(),
      history: [], transcript: [], currentAssistant: "", currentEvents: [],
    };
    this.live.set(sessionId, live);

    // Multi-account: resolve which codex account backs this session (sticky → strategy →
    // null = default ~/.codex). Spawn the app-server with that account's CODEX_HOME.
    const account = await resolveCodexAccountForSession(sessionId);

    client.onNotification((n) => this.handleNotification(live, n));
    client.onServerRequest((r) => this.handleServerRequest(live, r));
    client.onClose(() => this.handleClose(live));
    client.start({ cwd, codexHome: account?.home });

    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
    client.notify("initialized");

    const resumeBase = { cwd, sandbox: permission.sandbox, approvalPolicy: permission.approvalPolicy, ...(model ? { model } : {}) };
    // Only treat as a resume when a rollout for this id is attributable to THIS
    // project (fail-closed cwd guard) — never resume another project's thread.
    const isResume = !!findRolloutByThreadId(CODEX_SESSIONS_DIR, sessionId, cwd);
    const result = isResume
      ? await client.request("thread/resume", { threadId: sessionId, ...resumeBase })
      : await client.request("thread/start", resumeBase);

    const threadId = extractThreadId(result) ?? (isResume ? sessionId : null);
    if (!threadId) throw new Error("codex thread/start returned no thread id");
    live.threadId = threadId;

    if (threadId !== sessionId) {
      this.live.delete(sessionId);
      this.live.set(threadId, live);
      if (meta) { this.sessions.delete(sessionId); meta.id = threadId; this.sessions.set(threadId, meta); }
      setSessionMetadata(threadId, meta?.projectName, cwd);
      setSessionProvider(threadId, this.id); // route follow-ups to codex after restart
      if (account) setSessionCodexAccount(threadId, account.id); // sticky account
      channel.push({ type: "session_migrated", oldSessionId: sessionId, newSessionId: threadId });
    } else {
      setSessionMetadata(threadId, meta?.projectName, cwd);
      setSessionProvider(threadId, this.id);
      if (account) setSessionCodexAccount(threadId, account.id);
    }
    // Snapshot persisted history so live message ids continue the rollout-N
    // numbering (empty for a brand-new thread; full prior transcript on resume).
    live.history = getRolloutMessages(CODEX_SESSIONS_DIR, threadId, cwd);
    return live;
  }

  private handleNotification(live: LiveSession, notif: JsonRpcNotification): void {
    if (notif.method === "item/agentMessage/delta") {
      const d = (notif.params as { delta?: string })?.delta;
      if (typeof d === "string") live.currentAssistant += d;
    }
    const events = mapCodexEvent(notif, live.threadId ?? "");
    for (const ev of events) {
      live.channel.push(ev);
      // Accumulate tool calls into the turn so getMessages (live) keeps them.
      if (ev.type === "tool_use" || ev.type === "tool_result") live.currentEvents.push(ev);
    }
    if (notif.method === "turn/completed") {
      if (live.currentAssistant || live.currentEvents.length) {
        const turnEvents = live.currentEvents.length
          ? [...live.currentEvents, ...(live.currentAssistant ? [{ type: "text", content: live.currentAssistant } as ChatEvent] : [])]
          : undefined;
        live.transcript.push({
          id: nextRolloutId(live), role: "assistant", content: live.currentAssistant,
          ...(turnEvents ? { events: turnEvents } : {}), timestamp: new Date().toISOString(),
        });
      }
      live.currentAssistant = "";
      live.currentEvents = [];
    }
    // Manual /compact finished — codex signals via the contextCompaction item
    // (the thread/compacted notification is deprecated). Surface the compact-summary
    // marker inline so the chat UI offers "load previous conversation". The turn's
    // own turn/completed provides the `done`.
    if (notif.method === "item/completed" && live.compactRequested
        && (notif.params as { item?: { type?: string } })?.item?.type === "contextCompaction") {
      live.compactRequested = false;
      const file = findRolloutByThreadId(CODEX_SESSIONS_DIR, live.threadId ?? "", live.cwd);
      if (file) {
        const content = `_Conversation compacted to save context._\n\nread the full transcript at: ${file}`;
        live.channel.push({ type: "text", content });
        // Keep the live transcript consistent so getMessages (live reload) also shows it.
        live.transcript.push({ id: `codex-compact-${live.threadId}`, role: "assistant", content, timestamp: new Date().toISOString() });
      }
    }
  }

  private handleServerRequest(live: LiveSession, req: ServerRequest): void {
    const method = req.method;
    if (isApprovalMethod(method)) {
      const ppmReqId = crypto.randomUUID();
      live.pendingApprovals.set(ppmReqId, { codexId: req.id, method });
      live.channel.push({ type: "approval_request", requestId: ppmReqId, tool: approvalToolLabel(method, req.params), input: redactTruncate(req.params) });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      const ppmReqId = crypto.randomUUID();
      const questions = (req.params as { questions?: unknown })?.questions;
      live.pendingApprovals.set(ppmReqId, { codexId: req.id, method, questions });
      live.channel.push({ type: "approval_request", requestId: ppmReqId, tool: "AskUserQuestion", input: redactTruncate(req.params) });
      return;
    }
    // permissions/* response is a granted-profile, not a decision → decline.
    // Any other server request → decline so codex never hangs waiting.
    this.respondOnce(live, req.id, null, "unsupported server request");
  }

  resolveApproval(requestId: string, approved: boolean, data?: unknown): void {
    for (const live of this.live.values()) {
      const pending = live.pendingApprovals.get(requestId);
      if (!pending) continue;
      live.pendingApprovals.delete(requestId);
      if (pending.method === "item/tool/requestUserInput") {
        this.respondOnce(live, pending.codexId, buildUserInputResponse(pending.questions, data));
      } else if (isApprovalMethod(pending.method)) {
        this.respondOnce(live, pending.codexId, decisionFor(pending.method as ApprovalMethod, approved));
      }
      return;
    }
  }

  /** Idempotent + EPIPE-safe single response to a server request. */
  private respondOnce(live: LiveSession, codexId: number | string, result: unknown, errorMsg?: string): void {
    if (live.answeredCodexIds.has(codexId)) return;
    live.answeredCodexIds.add(codexId);
    if (errorMsg) live.client.respondError(codexId, errorMsg);
    else live.client.respond(codexId, result);
  }

  private declinePending(live: LiveSession): void {
    for (const [, pending] of live.pendingApprovals) {
      if (pending.method === "item/tool/requestUserInput") this.respondOnce(live, pending.codexId, { answers: {} });
      else if (isApprovalMethod(pending.method)) this.respondOnce(live, pending.codexId, decisionFor(pending.method as ApprovalMethod, false, true));
      else this.respondOnce(live, pending.codexId, null, "session ended");
    }
    live.pendingApprovals.clear();
  }

  // ── Lifecycle ──
  abortQuery(sessionId: string, _source?: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.declinePending(live);
    const proc = live.client.process;
    const pid = live.client.pid;
    live.client.close();
    if (process.platform === "win32" && pid) killProcessTree(pid);
    else if (proc) setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 2000).unref?.();
    this.live.delete(sessionId);
    live.channel.done();
  }

  /** Alias used by the WS consumer's teardown path (parity with Claude provider). */
  closeStreamingSession(sessionId: string): void {
    this.abortQuery(sessionId, "close_streaming");
  }

  private handleClose(live: LiveSession): void {
    for (const [k, v] of this.live) if (v === live) this.live.delete(k);
    live.channel.done();
  }

  hasStreamingSession(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return !!live && !live.client.isClosed;
  }

  /** Kill all live subprocesses — wired into server shutdown. */
  cleanupAll(): void {
    for (const sessionId of [...this.live.keys()]) this.abortQuery(sessionId, "cleanup");
  }

  // ── History ──
  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const live = this.live.get(sessionId);
    if (live && !live.client.isClosed) {
      const inflight: ChatMessage[] = live.currentAssistant
        ? [{ id: "inflight", role: "assistant", content: live.currentAssistant, timestamp: new Date().toISOString() }]
        : [];
      return [...live.history, ...live.transcript, ...inflight];
    }
    // Fail-closed: only return rollout messages attributable to this project's cwd.
    const cwd = this.sessions.get(sessionId)?.projectPath || getSessionProjectPath(sessionId);
    if (!cwd) return [];
    return getRolloutMessages(CODEX_SESSIONS_DIR, sessionId, cwd);
  }

  /**
   * Fork/rewind at a message (edit-message + branch). Codex has no fork-up-to-id,
   * so we `thread/fork` (full copy) then `thread/rollback` to drop the turns after
   * the anchor. Returns the new thread id; the caller resends the edited message.
   */
  async forkAtMessage(sessionId: string, messageId: string, opts?: { title?: string; dir?: string }): Promise<{ sessionId: string }> {
    const cwd = this.sessions.get(sessionId)?.projectPath || getSessionProjectPath(sessionId) || opts?.dir || process.cwd();
    const msgs = await this.getMessages(sessionId);
    const idx = msgs.findIndex((m) => (m.sdkUuid ?? m.id) === messageId);
    if (idx < 0) throw new Error("fork anchor message not found in transcript");
    // One user message per codex turn — count those up to the anchor (robust when a
    // turn carries tool calls + a final answer = multiple assistant messages).
    const turnsToKeep = msgs.slice(0, idx + 1).filter((m) => m.role === "user").length;

    const client = new CodexJsonRpcClient();
    try {
      client.start({ cwd });
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
      client.notify("initialized");
      const forkRes = await client.request<{ thread?: { id?: string; turns?: unknown[] } }>("thread/fork", { threadId: sessionId, cwd });
      const forkId = extractThreadId(forkRes);
      if (!forkId) throw new Error("thread/fork returned no thread id");
      const totalTurns = Array.isArray(forkRes?.thread?.turns) ? forkRes.thread!.turns!.length : turnsToKeep;
      const drop = Math.max(0, totalTurns - turnsToKeep);
      if (drop > 0) await client.request("thread/rollback", { threadId: forkId, numTurns: drop });
      setSessionMetadata(forkId, undefined, cwd);
      setSessionProvider(forkId, this.id);
      return { sessionId: forkId };
    } finally {
      client.close();
    }
  }

  // ── Capability probes ──
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([process.execPath, "x", "@openai/codex", "--version"], {
        stdout: "pipe", stderr: "pipe",
      });
      // 30s: a cold `bun x` may download the package, and the probe runs during
      // heavy concurrent server startup where process spawn can be starved.
      const timeout = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 30_000);
      await proc.exited;
      clearTimeout(timeout);
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.modelsCache && Date.now() < this.modelsCache.expiry) return this.modelsCache.models;
    const client = new CodexJsonRpcClient();
    try {
      client.start({ cwd: process.cwd() });
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES });
      client.notify("initialized");
      const all: unknown[] = [];
      let cursor: string | null = null;
      do {
        const res: ModelListResponse = await client.request<ModelListResponse>("model/list", { cursor });
        if (Array.isArray(res?.data)) all.push(...res.data);
        cursor = res?.nextCursor ?? null;
      } while (cursor);
      const models = parseModelList(all);
      if (models.length > 0) this.modelsCache = { models, expiry: Date.now() + MODELS_CACHE_TTL };
      return models;
    } catch {
      return [];
    } finally {
      client.close();
    }
  }

  /** Codex quota for the default account (account/rateLimits/read, 60s cache). */
  async getUsage(): Promise<UsageInfo> {
    return fetchCodexUsage();
  }
}
