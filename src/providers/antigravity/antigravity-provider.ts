import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AIProvider,
  ChatEvent,
  ChatMessage,
  ModelOption,
  SendMessageOpts,
  Session,
  SessionConfig,
  SessionInfo,
  UsageInfo,
} from "../provider.interface.ts";
import type { TurnUsage } from "../../shared/turn-usage.ts";
import { configService } from "../../services/config.service.ts";
import {
  getSessionAccount,
  getSessionProjectPath,
  getSessionTitle,
  getSessionTitles,
  setSessionAccount,
  setSessionMetadata,
  setSessionProvider,
} from "../../services/db.service.ts";
import { stripSharedContext } from "../../shared/provider-context.ts";
import { createLogger } from "../../services/logger.ts";
import { getOrFetchUsage, refreshUsage, registerUsageSource } from "../../services/provider-usage/usage-registry.ts";
import { AMBIENT_ACCOUNT_KEY } from "../../services/provider-usage/usage-source.ts";
import { isRecentlyFailed } from "../../services/provider-usage/usage-memory-cache.ts";
import {
  formatAntigravityAccountLabel,
  getAntigravityAccount,
  listAntigravityAccounts,
  peekAntigravityAccount,
  resolveAntigravityAccountForSession,
  type AntigravityAccount,
} from "../../services/antigravity-account.service.ts";
import { findAgyExecutable, resolveAntigravityPaths } from "./antigravity-connection.ts";
import {
  extractAntigravitySessionTitle,
  findAntigravityTranscriptPath,
  listAntigravitySessions,
  loadAntigravityHistory,
} from "./antigravity-history.ts";
import { fetchAntigravityModelsLive, resolveAntigravityModelId } from "./antigravity-models.ts";
import { antigravityUsageSource, fetchAntigravityUsageLive } from "./antigravity-usage.ts";
import { AcpClient, ACP_CONTROL_TIMEOUT_MS, type AcpNotification, type AcpServerRequest } from "./acp-client.ts";
import {
  acpModeFor,
  acpPromptBlocks,
  acpSystemPromptAppend,
  acpToolCard,
  acpTurnUsage,
  isCompactCommand,
  mapAcpUpdate,
  newToolState,
  permissionOutcome,
  stopReasonEvents,
  type AcpPermissionOption,
  type AcpToolState,
  type AcpUpdate,
} from "./acp-event-mapper.ts";
import { agyEnv, agyStoreArgs } from "./acp-launch.ts";
import { rememberAgyCommands } from "./antigravity-commands.ts";

const log = createLogger("antigravity");

/** `session/load` replays the whole chat before it answers; a long one takes seconds. */
const ACP_LOAD_TIMEOUT_MS = 120_000;
/** How long a stopped turn gets to settle in agy before its process is closed. */
const CANCEL_GRACE_MS = 3_000;

export interface AntigravityProviderOptions {
  /** HOME agy runs with and whose `.gemini` is read. Tests point it at a scratch directory. */
  customHome?: string;
  /** The argv that starts agy; `acp` and its flags are appended. Tests run a fake ACP server. */
  agyCommand?: string[];
}

interface EventChannel {
  push(ev: ChatEvent): void;
  done(): void;
  iterator: AsyncGenerator<ChatEvent, void, undefined>;
}

/** Unbounded async channel: agy's messages push events, the chat's generator drains them. */
function createEventChannel(): EventChannel {
  const queue: ChatEvent[] = [];
  let wake: ((ev: ChatEvent | null) => void) | null = null;
  let isDone = false;
  async function* gen(): AsyncGenerator<ChatEvent, void, undefined> {
    while (!isDone || queue.length > 0) {
      if (queue.length > 0) { yield queue.shift()!; continue; }
      const ev = await new Promise<ChatEvent | null>((r) => { wake = r; });
      if (ev) yield ev;
    }
  }
  return {
    push(ev) {
      if (isDone) return;
      if (wake) { const w = wake; wake = null; w(ev); }
      else queue.push(ev);
    },
    done() {
      isDone = true;
      if (wake) { const w = wake; wake = null; w(null); }
    },
    iterator: gen(),
  };
}

interface AcpSessionResult {
  sessionId?: string;
  models?: { currentModelId?: string };
  modes?: { currentModeId?: string };
}

interface AcpPromptResult {
  stopReason?: string;
  usage?: unknown;
}

/** One chat on its own `agy acp` process, alive from its first message until it is stopped or released. */
interface LiveSession {
  /** The id the chat was opened under, before agy named a new one. */
  callerId: string;
  client: AcpClient;
  channel: EventChannel;
  /** agy's id for the chat, which is also its conversation id on disk. Null until opened. */
  acpSessionId: string | null;
  meta: Session | null;
  /** Opening the chat, then every prompt, in the order they were sent. */
  chain: Promise<void>;
  /**
   * Prompts sent and not yet answered. A prompt sent while a turn runs is queued by agy, and
   * the earlier prompt is answered at once although its reply keeps streaming, so only the
   * last answer ends the turn.
   */
  inFlight: number;
  idleWaiters: Array<() => void>;
  tools: AcpToolState;
  pendingPermissions: Map<string, { rpcId: number | string; options: AcpPermissionOption[] }>;
  permissionMode?: string;
  modelId?: string;
  modeId?: string;
  usage?: TurnUsage;
  /** `session/load` replays the whole chat as updates, none of which is news. */
  loading: boolean;
  /** The chat was just created with the shared context in its system prompt, so its first message goes without it. */
  contextInSystemPrompt: boolean;
  closed: boolean;
}

export class AntigravityProvider implements AIProvider {
  readonly id = "antigravity";
  readonly name = "Antigravity";
  readonly supportsSharedContext = true;

  private sessions = new Map<string, Session>();
  private deletedSessions = new Set<string>();
  private migratedSessionIds = new Map<string, string>();
  private live = new Map<string, LiveSession>();
  private opts: AntigravityProviderOptions;

  constructor(opts: AntigravityProviderOptions = {}) {
    this.opts = opts;
  }

  getSharedContextSources(projectPath: string): Array<{ path: string; directory?: boolean; indexOnly?: boolean }> {
    const paths = resolveAntigravityPaths(this.opts.customHome);
    return [
      { path: join(projectPath, "GEMINI.md") },
      { path: join(projectPath, ".agents", "rules"), directory: true },
      { path: join(paths.geminiDir, "antigravity", "knowledge"), directory: true, indexOnly: true },
    ];
  }

  async isAvailable(): Promise<boolean> {
    if (this.opts.agyCommand) return true;
    if (findAgyExecutable(this.opts.customHome)) return true;
    const { brainDirs } = resolveAntigravityPaths(this.opts.customHome);
    return brainDirs.some((d) => existsSync(d));
  }

  async listModels(): Promise<ModelOption[]> {
    return fetchAntigravityModelsLive(this.opts.customHome);
  }

  async getUsage(sessionId?: string, pickedAccountId?: string): Promise<UsageInfo> {
    if (this.opts.customHome) {
      try {
        return await fetchAntigravityUsageLive(this.opts.customHome);
      } catch {
        return {};
      }
    }
    registerUsageSource(antigravityUsageSource);

    const accountId = sessionId ? getSessionAccount(sessionId) : pickedAccountId ?? null;
    const bound = accountId ? getAntigravityAccount(accountId) : null;
    if (bound) {
      const usage = await getOrFetchUsage(this.id, bound.id);
      return {
        ...usage,
        activeAccountId: bound.id,
        activeAccountLabel: formatAntigravityAccountLabel(bound),
      };
    }

    const pending = accountId ? null : peekAntigravityAccount();
    if (pending) {
      const usage = await getOrFetchUsage(this.id, pending.id);
      return {
        ...usage,
        activeAccountId: pending.id,
        activeAccountLabel: formatAntigravityAccountLabel(pending),
      };
    }

    const selectable = listAntigravityAccounts().filter((a) => a.status !== "disabled");
    if (selectable.length > 0) {
      const first = selectable[0]!;
      const usage = await getOrFetchUsage(this.id, first.id);
      return {
        ...usage,
        activeAccountId: first.id,
        activeAccountLabel: formatAntigravityAccountLabel(first),
      };
    }

    const usage = await getOrFetchUsage(this.id, AMBIENT_ACCOUNT_KEY);
    if (!usage.activeAccountLabel && !isRecentlyFailed(this.id, AMBIENT_ACCOUNT_KEY)) {
      return refreshUsage(this.id, AMBIENT_ACCOUNT_KEY);
    }
    return usage;
  }

  private getAllBrainDirs(): string[] {
    const dirs = [...resolveAntigravityPaths(this.opts.customHome).brainDirs];
    try {
      for (const acc of listAntigravityAccounts()) {
        if (acc.home) {
          for (const d of resolveAntigravityPaths(acc.home).brainDirs) {
            if (!dirs.includes(d)) dirs.push(d);
          }
        }
      }
    } catch { /* ignore if DB not initialized */ }
    return dirs;
  }

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
    try { setSessionMetadata(id, config.projectName, config.projectPath); } catch { /* ignore */ }
    return session;
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const brainDirs = this.getAllBrainDirs();
    let customTitle: string | undefined;
    let dbProjectPath: string | undefined;
    try {
      customTitle = getSessionTitle(sessionId) ?? undefined;
      dbProjectPath = getSessionProjectPath(sessionId) ?? undefined;
    } catch { /* ignore if DB not initialized */ }
    const resolvedTitle = customTitle ?? extractAntigravitySessionTitle(sessionId, brainDirs);

    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (resolvedTitle && (existing.title === "Resumed Chat" || existing.title === "New Chat")) {
        existing.title = resolvedTitle;
      }
      if (!existing.projectPath && dbProjectPath) {
        existing.projectPath = dbProjectPath;
      }
      return existing;
    }

    const session: Session = {
      id: sessionId,
      providerId: this.id,
      title: resolvedTitle ?? "New Chat",
      projectPath: dbProjectPath,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  ensureProjectPath(sessionId: string, path: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) existing.projectPath = path;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const brainDirs = this.getAllBrainDirs();
    const nativeRaw = (await listAntigravitySessions(this.id, { brainDirs }))
      .filter((s) => !this.deletedSessions.has(s.id));
    const inMemoryRaw = Array.from(this.sessions.values())
      .filter((s) => !this.deletedSessions.has(s.id));
    let customTitles: Record<string, string> = {};
    try {
      customTitles = getSessionTitles([...nativeRaw.map((s) => s.id), ...inMemoryRaw.map((s) => s.id)]);
    } catch { /* ignore */ }
    const native = nativeRaw.map((s) => ({
      ...s,
      title: customTitles[s.id] ?? s.title,
    }));
    const inMemory = inMemoryRaw.map((s) => ({
      id: s.id,
      providerId: s.providerId,
      title: customTitles[s.id] ?? s.title,
      projectName: s.projectName,
      createdAt: s.createdAt,
    }));
    const seen = new Set(native.map((s) => s.id));
    return [...native, ...inMemory.filter((s) => !seen.has(s.id))];
  }

  async listSessionsByDir(dir: string, opts?: { limit?: number; offset?: number }): Promise<SessionInfo[]> {
    const brainDirs = this.getAllBrainDirs();
    const nativeRaw = (await listAntigravitySessions(this.id, { projectPath: dir, brainDirs }))
      .filter((s) => !this.deletedSessions.has(s.id));
    const inMemoryRaw = Array.from(this.sessions.values())
      .filter((s) => s.projectPath === dir && !this.deletedSessions.has(s.id));
    let customTitles: Record<string, string> = {};
    try {
      customTitles = getSessionTitles([...nativeRaw.map((s) => s.id), ...inMemoryRaw.map((s) => s.id)]);
    } catch { /* ignore */ }
    const native = nativeRaw.map((s) => ({
      ...s,
      title: customTitles[s.id] ?? s.title,
    }));
    const inMemory = inMemoryRaw.map((s) => ({
      id: s.id,
      providerId: s.providerId,
      title: customTitles[s.id] ?? s.title,
      projectName: s.projectName,
      createdAt: s.createdAt,
    }));
    const seen = new Set(native.map((s) => s.id));
    const all = [...native, ...inMemory.filter((s) => !seen.has(s.id))];
    const start = Math.max(0, opts?.offset ?? 0);
    const end = opts?.limit !== undefined ? start + Math.max(0, opts.limit) : undefined;
    return all.slice(start, end);
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const brainDirs = this.getAllBrainDirs();
    return loadAntigravityHistory(sessionId, { brainDirs });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.abortQuery(sessionId, "delete");
    const migrated = this.migratedSessionIds.get(sessionId);
    this.deletedSessions.add(sessionId);
    if (migrated) {
      this.deletedSessions.add(migrated);
      this.sessions.delete(migrated);
    }
    this.migratedSessionIds.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  // ── Streaming over `agy acp` ──

  /**
   * Run a turn, then keep the chat's process for the turns after it: follow-ups come in through
   * `pushMessage` and their events through this same generator, which ends when the chat is
   * stopped or released.
   */
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    let live = this.live.get(sessionId);
    if (!live) {
      live = this.openLive(sessionId);
      live.chain = this.connect(live, sessionId, message, opts);
    }
    this.startPrompt(live, message, opts);
    for await (const ev of live.channel.iterator) {
      yield ev;
    }
  }

  /** A message sent while the chat's process is alive: between turns, or queued behind a running one. */
  pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): void {
    const live = this.live.get(sessionId);
    if (!live || live.closed) return;
    this.startPrompt(live, content, opts);
  }

  resolveApproval(requestId: string, approved: boolean): void {
    for (const live of new Set(this.live.values())) {
      const pending = live.pendingPermissions.get(requestId);
      if (!pending) continue;
      live.pendingPermissions.delete(requestId);
      live.client.respond(pending.rpcId, permissionOutcome(pending.options, approved));
      return;
    }
  }

  abortQuery(sessionId: string, _source?: string): void {
    const live = this.live.get(sessionId);
    if (live) this.closeLive(live);
  }

  /** Called by the chat socket when its loop over `sendMessage` ends. */
  closeStreamingSession(sessionId: string): void {
    this.abortQuery(sessionId, "close_streaming");
  }

  hasStreamingSession(sessionId: string): boolean {
    const live = this.live.get(sessionId);
    return !!live && !live.closed;
  }

  private openLive(sessionId: string): LiveSession {
    const live: LiveSession = {
      callerId: sessionId,
      client: new AcpClient(),
      channel: createEventChannel(),
      acpSessionId: null,
      meta: null,
      chain: Promise.resolve(),
      inFlight: 0,
      idleWaiters: [],
      tools: newToolState(),
      pendingPermissions: new Map(),
      loading: false,
      contextInSystemPrompt: false,
      closed: false,
    };
    this.live.set(sessionId, live);
    return live;
  }

  /**
   * Start agy for the chat and open it there: `session/load` for a chat on disk, `session/new`
   * otherwise. Only a new chat can be given a system prompt; agy keeps it with the chat.
   */
  private async connect(live: LiveSession, sessionId: string, message: string, opts?: SendMessageOpts): Promise<void> {
    try {
      const meta = this.sessions.get(sessionId) ?? await this.resumeSession(sessionId);
      live.meta = meta;
      if (meta.title === "New Chat" || meta.title === "Resumed Chat") {
        const firstLine = stripSharedContext(message).trim().split("\n").find((l) => l.trim().length > 0)?.trim();
        if (firstLine) meta.title = firstLine.slice(0, 80);
      }

      const existing = findAntigravityTranscriptPath(sessionId, this.getAllBrainDirs());
      const account = await this.accountFor(sessionId, existing?.brainDir);
      if (live.closed) return;
      if (account) {
        live.channel.push({ type: "account_info", accountId: account.id, accountLabel: formatAntigravityAccountLabel(account) });
      }

      const home = this.opts.customHome || account?.home || undefined;
      const command = this.opts.agyCommand ?? (() => {
        const exe = findAgyExecutable(home);
        return exe ? [exe] : null;
      })();
      if (!command) {
        throw new Error("Antigravity's command-line tool (agy) was not found. Install it and sign in with `agy acp --login`, then send the message again.");
      }
      const cwd = meta.projectPath || process.cwd();
      const storeArgs = agyStoreArgs(home ?? process.env.HOME ?? homedir(), existing?.brainDir);
      live.client.onNotification((n) => this.handleNotification(live, n));
      live.client.onServerRequest((r) => this.handleServerRequest(live, r));
      live.client.onClose((code) => this.handleClose(live, code));
      live.client.start([...command, "acp", ...storeArgs], {
        cwd,
        env: agyEnv(home, !this.opts.customHome && !!account?.home),
      });
      log.info(`session=${sessionId} agy acp started pid=${live.client.pid ?? "?"} store=${storeArgs[1] ?? "antigravity-cli"} ${existing ? "load" : "new"} account=${account?.id ?? "ambient"}`);

      await live.client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "ppm", version: "0.0.0" },
      }, ACP_CONTROL_TIMEOUT_MS);

      let opened: AcpSessionResult | undefined;
      if (existing) {
        live.loading = true;
        try {
          opened = await live.client.request<AcpSessionResult>("session/load", { sessionId, cwd, mcpServers: [] }, ACP_LOAD_TIMEOUT_MS);
        } finally {
          live.loading = false;
        }
        live.acpSessionId = sessionId;
      } else {
        const append = acpSystemPromptAppend(this.providerConfig()?.system_prompt, opts?.sharedContext);
        opened = await live.client.request<AcpSessionResult>("session/new", {
          cwd,
          mcpServers: [],
          ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}),
        }, ACP_CONTROL_TIMEOUT_MS);
        if (!opened?.sessionId) throw new Error("agy opened no session.");
        live.contextInSystemPrompt = !!opts?.sharedContext;
        live.acpSessionId = opened.sessionId;
        if (opened.sessionId !== sessionId) this.migrate(live, sessionId, opened.sessionId, meta, cwd, account);
        else this.bindSession(sessionId, meta, cwd, account);
      }
      live.modelId = opened?.models?.currentModelId;
      live.modeId = opened?.modes?.currentModeId;
      if (live.closed) return;
      live.channel.push({ type: "system", subtype: "init" });
    } catch (err) {
      if (live.closed) return;
      log.warn(`session=${sessionId} agy acp failed to open the chat: ${(err as Error).message}`);
      live.channel.push({ type: "error", message: `Antigravity connection failed: ${(err as Error).message}` });
      live.channel.push({ type: "done", sessionId: live.acpSessionId ?? sessionId, resultSubtype: "error_during_execution" });
      this.closeLive(live);
    }
  }

  /** The account a chat runs on: the one whose home holds its files, else the one picked for it. */
  private async accountFor(sessionId: string, brainDir?: string): Promise<AntigravityAccount | null> {
    if (brainDir) {
      try {
        for (const acc of listAntigravityAccounts()) {
          if (acc.home && brainDir.startsWith(resolve(acc.home))) {
            try { setSessionAccount(sessionId, acc.id); } catch { /* ignore */ }
            return acc;
          }
        }
      } catch { /* ignore if DB not initialized */ }
    }
    if (this.opts.customHome || this.opts.agyCommand) return null;
    return resolveAntigravityAccountForSession(sessionId);
  }

  /**
   * agy names a new chat itself. The id the caller created stays mapped to the live session as
   * well, so a follow-up or a Stop sent under it still reaches the process.
   */
  private migrate(live: LiveSession, oldId: string, newId: string, meta: Session, cwd: string, account: AntigravityAccount | null): void {
    this.migratedSessionIds.set(oldId, newId);
    this.live.set(newId, live);
    this.sessions.delete(oldId);
    const moved = { ...meta, id: newId };
    this.sessions.set(newId, moved);
    live.meta = moved;
    this.bindSession(newId, moved, cwd, account);
    live.channel.push({ type: "session_migrated", oldSessionId: oldId, newSessionId: newId });
  }

  private bindSession(sessionId: string, meta: Session, cwd: string, account: AntigravityAccount | null): void {
    try {
      setSessionMetadata(sessionId, meta.projectName, cwd);
      setSessionProvider(sessionId, this.id);
      if (account) setSessionAccount(sessionId, account.id);
    } catch { /* ignore if DB not initialized */ }
  }

  private providerConfig() {
    try { return configService.get("ai").providers[this.id] ?? null; } catch { return null; }
  }

  /** Queue a prompt behind whatever was sent before it. Only its sending waits, never its turn. */
  private startPrompt(live: LiveSession, message: string, opts?: SendMessageOpts): void {
    live.chain = live.chain.then(async () => {
      if (live.closed || !live.acpSessionId) return;
      const cfg = this.providerConfig();
      live.permissionMode = opts?.permissionMode ?? live.permissionMode ?? cfg?.permission_mode;
      if (live.inFlight === 0) {
        await this.applySettings(live, resolveAntigravityModelId(opts?.model || cfg?.model, opts?.effort || cfg?.effort));
        if (live.closed) return;
        live.tools = newToolState();
        live.usage = undefined;
      }
      const sharedContext = live.contextInSystemPrompt ? undefined : opts?.sharedContext;
      live.contextInSystemPrompt = false;
      const compacting = isCompactCommand(message);
      if (compacting) live.channel.push({ type: "system", subtype: "compacting" });
      live.inFlight++;
      live.client.request<AcpPromptResult>("session/prompt", { sessionId: live.acpSessionId, prompt: acpPromptBlocks(message, { ...opts, sharedContext }) })
        .then((res) => {
          if (compacting && res?.stopReason === "end_turn" && !live.closed) live.channel.push({ type: "system", subtype: "compact_done" });
          this.onPromptAnswered(live, res);
        }, (err) => this.onPromptFailed(live, err));
    });
  }

  /** Model, effort and mode are per chat in agy, so they are set before a turn whenever they differ. */
  private async applySettings(live: LiveSession, modelId: string): Promise<void> {
    if (modelId !== live.modelId) {
      try {
        await live.client.request("session/set_model", { sessionId: live.acpSessionId, modelId }, ACP_CONTROL_TIMEOUT_MS);
        live.modelId = modelId;
      } catch (err) {
        log.warn(`session=${live.acpSessionId} agy refused model ${modelId}: ${(err as Error).message}`);
      }
    }
    const modeId = acpModeFor(live.permissionMode);
    if (live.modeId && modeId !== live.modeId) {
      try {
        await live.client.request("session/set_mode", { sessionId: live.acpSessionId, modeId }, ACP_CONTROL_TIMEOUT_MS);
        live.modeId = modeId;
      } catch (err) {
        log.warn(`session=${live.acpSessionId} agy refused mode ${modeId}: ${(err as Error).message}`);
      }
    }
  }

  private onPromptAnswered(live: LiveSession, res: AcpPromptResult | undefined): void {
    live.inFlight = Math.max(0, live.inFlight - 1);
    const usage = acpTurnUsage(res?.usage, live.modelId ?? "antigravity");
    if (usage) live.usage = usage;
    if (live.inFlight > 0) return;
    this.settle(live);
    if (live.closed) return;
    for (const ev of stopReasonEvents(res?.stopReason, live.acpSessionId!, live.usage)) live.channel.push(ev);
  }

  private onPromptFailed(live: LiveSession, err: unknown): void {
    live.inFlight = Math.max(0, live.inFlight - 1);
    if (live.inFlight === 0) this.settle(live);
    if (live.closed) return;
    live.channel.push({ type: "error", message: `Antigravity: ${(err as Error)?.message ?? String(err)}` });
    if (live.inFlight === 0) {
      live.channel.push({ type: "done", sessionId: live.acpSessionId!, resultSubtype: "error_during_execution" });
    }
  }

  private settle(live: LiveSession): void {
    for (const wake of live.idleWaiters.splice(0)) wake();
  }

  private handleNotification(live: LiveSession, n: AcpNotification): void {
    if (n.method !== "session/update" || live.closed) return;
    const update = (n.params as { update?: AcpUpdate } | undefined)?.update;
    if (!update) return;
    // What the chat can run now, not part of its history, so kept while a load replays too.
    if (update.sessionUpdate === "available_commands_update") {
      if (live.meta?.projectPath) rememberAgyCommands(live.meta.projectPath, update.availableCommands);
      return;
    }
    if (live.loading) return;
    if (update.sessionUpdate === "session_info_update") {
      const title = typeof update.title === "string" ? update.title.trim() : "";
      if (title && live.meta) live.meta.title = title.slice(0, 80);
      return;
    }
    for (const ev of mapAcpUpdate(update, live.tools)) live.channel.push(ev);
  }

  private handleServerRequest(live: LiveSession, req: AcpServerRequest): void {
    if (req.method !== "session/request_permission") {
      // PPM offers agy no file system or terminal of its own; agy runs its tools itself.
      live.client.respondError(req.id, -32601, `Method not found: ${req.method}`);
      return;
    }
    const params = req.params as { toolCall?: Parameters<typeof acpToolCard>[0]; options?: AcpPermissionOption[] } | undefined;
    const options = Array.isArray(params?.options) ? params.options : [];
    if (live.permissionMode === "bypassPermissions") {
      live.client.respond(req.id, permissionOutcome(options, true));
      return;
    }
    const requestId = crypto.randomUUID();
    live.pendingPermissions.set(requestId, { rpcId: req.id, options });
    live.channel.push({ type: "approval_request", requestId, ...acpToolCard(params?.toolCall ?? {}) });
  }

  private handleClose(live: LiveSession, code: number | null): void {
    if (live.closed) return;
    const detail = live.client.lastStderr ? `: ${live.client.lastStderr}` : "";
    log.error(`session=${live.acpSessionId ?? live.callerId} agy acp pid=${live.client.pid ?? "?"} exited unexpectedly code=${code} inFlight=${live.inFlight}${detail}`);
    if (live.inFlight > 0 || !live.acpSessionId) {
      live.channel.push({ type: "error", message: `Antigravity stopped unexpectedly (exit code ${code ?? "unknown"})${detail}. Send the message again to continue.` });
      live.channel.push({ type: "done", sessionId: live.acpSessionId ?? live.callerId, resultSubtype: "error_during_execution" });
    }
    this.closeLive(live);
  }

  /**
   * End the chat's generator and its process. A running turn is cancelled first and given a
   * moment to settle, so agy records it as stopped rather than losing it with the process.
   */
  private closeLive(live: LiveSession): void {
    if (live.closed) return;
    live.closed = true;
    for (const [id, entry] of this.live) if (entry === live) this.live.delete(id);
    for (const pending of live.pendingPermissions.values()) {
      live.client.respond(pending.rpcId, { outcome: { outcome: "cancelled" } });
    }
    live.pendingPermissions.clear();
    live.channel.done();
    if (live.inFlight === 0 || !live.acpSessionId) {
      live.client.close();
      return;
    }
    live.client.notify("session/cancel", { sessionId: live.acpSessionId });
    const timer = setTimeout(() => live.client.close(), CANCEL_GRACE_MS);
    timer.unref?.();
    live.idleWaiters.push(() => {
      clearTimeout(timer);
      live.client.close();
    });
  }
}
