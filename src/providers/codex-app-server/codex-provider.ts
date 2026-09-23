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
import { withSharedContext } from "../../shared/provider-context.ts";
import { setSessionMetadata, getSessionProjectPath, setSessionProvider, setSessionCodexAccount, getSessionCodexAccount, getSessionTitles, insertTurnUsage } from "../../services/db.service.ts";
import {
  resolveCodexAccountForSession,
  getCodexAccount,
  listCodexAccounts,
  peekCodexAccount,
  selectCodexAccount,
  getAllCodexUsages,
  getCodexAccountUsage,
  codexUsageLevel,
  type CodexAccount,
} from "../../services/codex-account.service.ts";
import { dailyGuardMessage, dailyGuardState } from "../../shared/codex-daily-guard.ts";
import { isCodexAccountUsageLimited, markCodexAccountUsageLimited } from "../../services/codex-account-cooldown.ts";
import { isCodexUsageLimit, codexErrorMessage, parseCodexUsageLimitReset } from "./codex-usage-limit.ts";
import { killProcessTree } from "../../services/windows-process-tree.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexJsonRpcClient, CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";
import { permissionModeToCodex, type CodexPermission } from "./codex-permission-map.ts";
import { buildThreadParams, requestWithInstructionsFallback, type CodexThreadParams } from "./codex-thread-params.ts";
import { mapCodexEvent, parseTokenUsage } from "./codex-event-mapper.ts";
import { subagentCardId } from "./codex-subagent-thread.ts";
import { decisionFor, isApprovalMethod, type ApprovalMethod } from "./codex-approval-decision.ts";
import { parseModelList } from "./codex-model-parser.ts";
import { getOrFetchUsage, registerUsageSource } from "../../services/provider-usage/usage-registry.ts";
import { codexUsageSource } from "./codex-usage-source.ts";
import { AMBIENT_ACCOUNT_KEY } from "../../services/provider-usage/usage-source.ts";
import { redactTruncate } from "./codex-redact.ts";
import { localizeRollout } from "./codex-rollout-transfer.ts";
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
  UserInput,
  CodexSkill,
} from "./codex-protocol.ts";
import { parseSkillList } from "./codex-skill-parser.ts";

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

/**
 * Every directory a codex rollout for this install could be in, most specific
 * first.
 *
 * `~/.codex/sessions` is only the ambient login's. PPM gives each managed
 * account its own CODEX_HOME, and the app-server writes that account's
 * transcripts under it — so a session bound to an account has its history
 * nowhere near the default directory. Reading only the default is why such a
 * conversation came back empty once it was no longer live in memory: it was
 * being served from the in-process transcript, and nothing on disk was ever
 * found for it.
 *
 * `sessionId` puts the bound account's directory FIRST, because a thread that
 * has been continued on that account has its newest rollout there. It no longer
 * restricts the search to it: an account switch — manual, or forced by a usage
 * limit — leaves the conversation's history in the home of whichever account
 * was serving when it was written. Searching the bound account alone is what
 * made a switched session come back empty and silently start over as a new
 * thread, since resume is only attempted when a rollout is found.
 */
function codexSessionsDirs(sessionId?: string): string[] {
  const dirs: string[] = [];
  const boundId = sessionId ? getSessionCodexAccount(sessionId) : null;
  const accounts = listCodexAccounts();
  const ordered = boundId
    ? [...accounts.filter((a) => a.id === boundId), ...accounts.filter((a) => a.id !== boundId)]
    : accounts;
  for (const account of ordered) dirs.push(join(account.home, "sessions"));
  dirs.push(CODEX_SESSIONS_DIR);
  return dirs;
}

/** First non-empty result across the candidate directories. */
function fromCodexSessionsDirs<T>(sessionId: string | undefined, read: (dir: string) => T | null): T | null {
  for (const dir of codexSessionsDirs(sessionId)) {
    const found = read(dir);
    if (found != null) return found;
  }
  return null;
}

/**
 * The rollout for a thread AND the sessions directory it was found in.
 *
 * The directory is what a plain path cannot tell us, and resuming needs it: a rollout
 * belonging to another account has to be copied into the serving account's own home before
 * codex will resolve it, and the copy has to keep its position relative to that directory.
 */
function locateRollout(
  sessionId: string,
  cwd: string,
): { path: string; sessionsDir: string } | null {
  for (const dir of codexSessionsDirs(sessionId)) {
    const found = findRolloutByThreadId(dir, sessionId, cwd);
    if (found) return { path: found, sessionsDir: dir };
  }
  return null;
}

/** Where the app-server on this account writes and looks for rollouts. */
function sessionsDirForHome(codexHome?: string): string {
  return codexHome ? join(codexHome, "sessions") : CODEX_SESSIONS_DIR;
}
const CLIENT_INFO = { name: "ppm", title: "PPM", version: "0.0.0" };
const CAPABILITIES = { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null };
const MODELS_CACHE_TTL = 5 * 60 * 1000;
const SKILLS_CACHE_TTL = 60 * 1000;

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
  /** Design instructions, resent on every thread/start and thread/resume — codex does not
   *  persist them, and the account-switch respawn has no send options to read them from. */
  developerInstructions?: string;
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
  /** Token counts from the most recent usage notification, attached to `done`. */
  lastUsage?: import("../../shared/turn-usage.ts").TurnUsage;
  /** Spawned thread ids. Notifications from these threads belong inside their Agent card. */
  subagentThreadIds: Set<string>;
  /** A turn is running on the thread. Codex accepts exactly one at a time: a
   *  second `turn/start` resolves with the ALREADY-RUNNING turn (same id,
   *  status `inProgress`) and silently discards the new input — no error, so
   *  nothing downstream can notice. Follow-ups therefore wait in `pendingTurns`
   *  and are sent when the running turn reports `turn/completed`. */
  turnInFlight?: boolean;
  /** A daily-guard usage read is in progress before the next turn starts. */
  checkingDailyGuard?: boolean;
  /** Id of the running turn — `turn/interrupt` needs it, `threadId` alone is rejected. */
  activeTurnId?: string | null;
  /** Interrupt asked for before `turn/started` named the turn; fired on arrival. */
  interruptRequested?: boolean;
  /** Follow-ups waiting for the current turn, in the order they will be sent. */
  pendingTurns: QueuedTurn[];
  /** A usage-limit rotation is underway: the old app-server is being torn down and
   *  replaced by one running on another account. Everything the dying subprocess still
   *  emits belongs to the turn being abandoned, so it is dropped rather than shown. */
  rotating?: boolean;
  /** The turn currently in flight, kept so a rotation can send it again on the new
   *  account. Cleared when the turn ends — there is then nothing to replay. */
  lastTurnInput?: { message: string; opts?: SendMessageOpts };
}

/** A follow-up held back because a turn was already running. */
interface QueuedTurn {
  message: string;
  opts?: SendMessageOpts;
  /** `later` sinks to the end of the queue; `now`/`next` go in front of it. */
  priority: "now" | "next" | "later";
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

/** The app-server puts the owner thread on every item notification.  An
 * `agentThreadId` inside a SubAgentActivity is the newly spawned child, so it
 * must never be used here: that would nest the launch card inside itself. */
export function threadIdFromNotification(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  const direct = p.threadId ?? p.thread_id;
  if (typeof direct === "string" && direct) return direct;
  const thread = p.thread;
  if (thread && typeof thread === "object" && typeof (thread as Record<string, unknown>).id === "string") {
    return (thread as Record<string, unknown>).id as string;
  }
  return null;
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

function missingRolloutError(sessionId: string): Error {
  return new Error(`Cannot resume Codex session ${sessionId}: its transcript was not found in the available account homes for this project. Restore the original account/transcript and retry, or explicitly open a new chat.`);
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
  readonly supportsSharedContext = true;
  readonly supportsDesignInstructions = true;
  readonly id = "codex";
  readonly name = "Codex";

  private sessions = new Map<string, Session>();
  /** Only IDs minted here may start a thread. Missing history is never proof of a new chat. */
  private unstartedSessions = new Set<string>();
  private live = new Map<string, LiveSession>();
  private modelsCache: { models: ModelOption[]; expiry: number } | null = null;
  private modelsPending: Promise<ModelOption[]> | null = null;
  /** Keyed by `cwd\0codexHome` — skills differ per workspace AND per account. */
  private skillsCache = new Map<string, { skills: CodexSkill[]; expiry: number }>();

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
    this.unstartedSessions.add(id);
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
    const seen = new Set<string>();
    const sessions: SessionInfo[] = [];
    for (const sessionsDir of codexSessionsDirs()) {
      for (const s of listCodexRollouts(sessionsDir, dir, this.id, opts)) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        sessions.push(s);
      }
    }
    // A title the user set by hand outranks the one derived from the opening
    // prompt, and it is the only place a renamed codex session is recorded.
    const customTitles = getSessionTitles(sessions.map((s) => s.id));
    for (const s of sessions) s.title = customTitles[s.id] ?? s.title;

    // Backfill provider ownership so reopening a pre-existing codex thread routes
    // to codex (not the default provider) even after a restart.
    //
    // The project path is recorded in the same pass, and it has to be: reading a
    // session is fail-closed on cwd, so a row registered here without one can
    // never be read back and the conversation opens blank. `dir` is exactly that
    // cwd — every rollout listed above matched it — so the attribution is the
    // one already proven, not a guess.
    for (const s of sessions) {
      try {
        setSessionProvider(s.id, this.id);
        setSessionMetadata(s.id, s.projectName, dir);
      } catch { /* non-fatal */ }
    }
    return sessions;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.abortQuery(sessionId, "delete");
    this.sessions.delete(sessionId);
    this.unstartedSessions.delete(sessionId);
  }

  // ── Streaming (multi-turn) ──
  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    let live = this.live.get(sessionId);
    if (!live) {
      try {
        live = await this.connect(sessionId, opts);
      } catch (err) {
        this.abortQuery(sessionId, "connect_failed");
        yield { type: "error", message: redactTruncate((err as Error)?.message ?? String(err), 512) };
        yield { type: "done", sessionId, resultSubtype: "error_during_execution" };
        return;
      }
    }
    void this.startTurn(live, message, opts);
    for await (const ev of live.channel.iterator) {
      yield ev;
    }
  }

  /** Follow-up turn on the live session (turn 2+). Fire-and-forget per WS contract. */
  pushMessage(sessionId: string, content: string, opts?: SendMessageOpts): void {
    const live = this.live.get(sessionId);
    if (!live || live.client.isClosed) return;
    void this.startTurn(live, content, opts);
  }

  /** Return a refusal only when this session's managed account opted into pacing. */
  private async dailyGuardError(live: LiveSession): Promise<string | null> {
    const accountId = live.threadId ? getSessionCodexAccount(live.threadId) : null;
    const account = accountId ? getCodexAccount(accountId) : null;
    if (!account?.dailyGuardEnabled) return null;
    try {
      const usage = await getCodexAccountUsage(account.id);
      const state = usage.session == null ? dailyGuardState(usage.weekly) : null;
      return state?.blocked ? dailyGuardMessage(state) : null;
    } catch {
      // An unreadable quota cannot honestly be called spent. Keep the account usable and let
      // Codex's real quota refusal remain the authority until the next successful usage read.
      return null;
    }
  }

  /**
   * Send a turn on the live thread.
   *
   * `replay` marks the same turn being sent again on a different account after a usage
   * limit. It skips the transcript append only: the user typed the message once, and a
   * second entry would both show it twice and shift every later `rollout-N` id, which
   * fork anchors resolve against.
   */
  private async startTurn(live: LiveSession, message: string, opts?: SendMessageOpts, replay = false): Promise<void> {
    if (!live.threadId) return;
    // One turn at a time — anything sent now would be dropped without a trace.
    // `now` additionally cuts the running turn short so this one answers next.
    if (live.turnInFlight) {
      const priority = opts?.priority ?? "next";
      this.enqueueTurn(live, { message, opts, priority });
      if (priority === "now") this.interruptActiveTurn(live);
      return;
    }
    if (live.checkingDailyGuard) {
      this.enqueueTurn(live, { message, opts, priority: opts?.priority ?? "next" });
      return;
    }
    live.checkingDailyGuard = true;
    const guardError = await this.dailyGuardError(live);
    live.checkingDailyGuard = false;
    if (guardError) {
      live.channel.push({ type: "error", message: guardError });
      live.channel.push({ type: "done", sessionId: live.threadId, resultSubtype: "error_during_execution" });
      this.endTurn(live);
      return;
    }
    live.turnInFlight = true;
    // `/compact` → trigger codex's real compaction (thread/compact/start), not a text turn.
    // Completion is surfaced on the `thread/compacted` notification (handleNotification).
    if (message.trim() === "/compact") {
      live.compactRequested = true;
      live.client.request("thread/compact/start", { threadId: live.threadId }).catch((err) => {
        live.compactRequested = false;
        if (!live.client.isClosed) live.channel.push({ type: "error", message: redactTruncate((err as Error)?.message ?? String(err), 256) });
        live.channel.push({ type: "done", sessionId: live.threadId ?? "", resultSubtype: "error_during_execution" });
        this.endTurn(live);
      });
      return;
    }
    if (!replay) live.transcript.push({ id: nextRolloutId(live), role: "user", content: message, timestamp: new Date().toISOString() });
    live.lastTurnInput = { message, opts };
    live.currentAssistant = "";
    live.currentEvents = [];
    live.lastUsage = undefined;
    // Codex takes an image as a path, never as a payload, so the uploaded copy is what it
    // gets. Images lead: the text usually refers to them ("what is this?").
    const input: UserInput[] = [
      ...(opts?.imagePaths ?? []).map((path) => ({ type: "localImage" as const, path })),
      { type: "text" as const, text: withSharedContext(message, opts?.sharedContext), text_elements: [] },
    ];
    const turnModel = codexModel(opts?.model);
    const turnEffort = opts?.effort ?? this.config?.effort;
    const configuredThinking = this.config?.thinking_budget_tokens;
    // Codex does not accept a token budget. Its equivalent is an effort level,
    // while `summary` controls the safe thinking text the UI can show.
    const thinkingEnabled = (opts?.thinkingBudget ?? configuredThinking ?? -1) !== 0;
    live.client.request("turn/start", {
      threadId: live.threadId,
      input,
      ...(turnModel ? { model: turnModel } : {}),
      ...(turnEffort ? { effort: turnEffort } : {}),
      summary: thinkingEnabled ? "detailed" : "none",
    }).then((res) => {
      // Backup for the `turn/started` notification, which is what normally names
      // the turn — an interrupt arriving in between has nothing to address.
      const id = (res as { turn?: { id?: string } })?.turn?.id;
      if (id && !live.activeTurnId) this.setActiveTurn(live, id);
    }).catch((err) => {
      const reason = (err as Error)?.message ?? String(err);
      // A quota refusal can come back as the rejection of the request itself rather than
      // as an `error` notification, and it is the same situation either way — move the
      // turn to an account that still has room instead of showing the refusal.
      if (isCodexUsageLimit(reason) && this.beginRotation(live, reason)) return;
      if (!live.client.isClosed) live.channel.push({ type: "error", message: redactTruncate(reason, 256) });
      // No turn is running, so nothing will report `turn/completed` — release the
      // queue here or every later follow-up waits on a turn that never existed.
      this.endTurn(live);
    });
  }

  /** Insert a follow-up: `later` sinks behind everything, `now`/`next` queue ahead of it. */
  private enqueueTurn(live: LiveSession, item: QueuedTurn): void {
    if (item.priority === "later") {
      live.pendingTurns.push(item);
      return;
    }
    const firstLater = live.pendingTurns.findIndex((q) => q.priority === "later");
    if (firstLater === -1) live.pendingTurns.push(item);
    else live.pendingTurns.splice(firstLater, 0, item);
  }

  /** Cut the running turn short. Falls back to waiting it out when the interrupt
   *  cannot be sent — the follow-up stays queued either way, never dropped. */
  private interruptActiveTurn(live: LiveSession): void {
    if (!live.activeTurnId) { live.interruptRequested = true; return; }
    live.client.request("turn/interrupt", { threadId: live.threadId, turnId: live.activeTurnId })
      .catch(() => { /* turn already ending — the queue drains on turn/completed */ });
  }

  private setActiveTurn(live: LiveSession, turnId: string): void {
    live.activeTurnId = turnId;
    if (live.interruptRequested) {
      live.interruptRequested = false;
      this.interruptActiveTurn(live);
    }
  }

  /** Running turn is over: send the next follow-up, if one is waiting. */
  private endTurn(live: LiveSession): void {
    live.turnInFlight = false;
    live.activeTurnId = null;
    live.interruptRequested = false;
    live.lastTurnInput = undefined;
    const next = live.pendingTurns.shift();
    if (next) void this.startTurn(live, next.message, next.opts);
  }

  // ── Usage-limit rotation ──

  /**
   * Take over a turn Codex refused for an exhausted quota, if another account can serve it.
   *
   * Answers synchronously so the caller knows, before it decides what to show, whether the
   * refusal is being handled or has to be reported. The rotation itself is asynchronous —
   * it respawns a subprocess and resumes the thread — but whether one is possible is a
   * question about which accounts exist, which needs no I/O.
   *
   * Returns false when nothing else could serve the turn, and the refusal then reaches the
   * user untouched. That is the honest outcome: an error saying the quota is spent is worth
   * more than a silent retry on the account that just said so.
   */
  private beginRotation(live: LiveSession, reason: string): boolean {
    const threadId = live.threadId;
    if (!threadId || live.rotating) return false;
    const currentId = getSessionCodexAccount(threadId);
    const candidates = listCodexAccounts().filter(
      (a) => a.status !== "disabled" && a.id !== currentId && !isCodexAccountUsageLimited(a.id),
    );
    if (candidates.length === 0) return false;
    live.rotating = true;
    void this.rotateAccount(live, threadId, currentId, reason);
    return true;
  }

  /** Park the spent account, move the session onto a fresh one, and send the turn again. */
  private async rotateAccount(
    live: LiveSession,
    threadId: string,
    currentId: string | null,
    reason: string,
  ): Promise<void> {
    const pending = live.lastTurnInput;
    const reset = parseCodexUsageLimitReset(reason);
    if (currentId) markCodexAccountUsageLimited(currentId, reset?.atMs);

    let next: CodexAccount | null = null;
    try {
      // Usage picks the emptiest of the remaining accounts rather than merely the next one,
      // so a rotation forced by a limit does not land on an account that is nearly at its own.
      const usages = await getAllCodexUsages();
      next = selectCodexAccount({
        usageOf: (id) => codexUsageLevel(usages[id]),
        ...(currentId ? { exclude: [currentId] } : {}),
      });
    } catch {
      next = selectCodexAccount(currentId ? { exclude: [currentId] } : undefined);
    }

    if (!next) { this.abandonRotation(live, reason, reset?.text); return; }

    console.warn(`[codex] session=${threadId} usage limit — switching to ${next.id} (${next.label})`);
    live.channel.push({
      type: "account_retry",
      reason: "Usage limit reached — switching account",
      accountId: next.id,
      accountLabel: next.label,
    });

    try {
      await this.respawnOn(live, threadId, next);
    } catch (e) {
      console.error(`[codex] session=${threadId} rotation to ${next.id} failed: ${redactTruncate((e as Error)?.message, 200)}`);
      this.abandonRotation(live, reason, reset?.text);
      return;
    }

    live.rotating = false;
    // The refused turn never reached `turn/completed`, so the flags it set are still on.
    live.turnInFlight = false;
    live.activeTurnId = null;
    live.interruptRequested = false;
    if (pending) void this.startTurn(live, pending.message, pending.opts, true);
    else this.endTurn(live);
  }

  /** No account could take the turn — report the refusal and close the turn out. */
  private abandonRotation(live: LiveSession, reason: string, resetText?: string): void {
    live.rotating = false;
    const suffix = resetText ? ` Try again ${resetText}.` : "";
    live.channel.push({
      type: "error",
      message: `${redactTruncate(reason, 512)}${suffix} Add another account in Settings → Accounts, or wait for the reset.`,
    });
    live.channel.push({ type: "done", sessionId: live.threadId ?? "", resultSubtype: "error_during_execution" });
    this.endTurn(live);
  }

  /**
   * Put this session's app-server on another account, keeping the session itself intact.
   *
   * The subprocess is replaced, not the `LiveSession`: the caller of `sendMessage` is
   * iterating this session's channel, and handing it a new one would end its stream mid-turn
   * and leave the rest of the answer with nobody listening. Transcript, history and pending
   * follow-ups all survive for the same reason.
   *
   * The outgoing client's handlers are cleared before it is closed. `close()` only asks the
   * process to exit, so its `close` event lands well after this returns — by which time
   * `rotating` is off again, and the inherited `onClose` would tear down the session that
   * had just been repaired.
   */
  private async respawnOn(live: LiveSession, threadId: string, account: CodexAccount): Promise<void> {
    // Validate before replacing the client or its account binding. A missing file
    // can mean inaccessible history, including on the first turn; it cannot justify
    // migrating an existing provider thread onto an empty conversation.
    const found = locateRollout(threadId, live.cwd);
    if (!found) throw missingRolloutError(threadId);
    const old = live.client;
    old.onNotification(() => {});
    old.onServerRequest(() => {});
    old.onClose(() => {});
    const pid = old.pid;
    const proc = old.process;
    old.close();
    if (process.platform === "win32" && pid) killProcessTree(pid);
    else if (proc) setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* dead */ } }, 2000).unref?.();

    // Locate history while the outgoing account is still bound, so its current
    // transcript wins. Then bind the account that will receive the localized copy.
    setSessionCodexAccount(threadId, account.id);

    const client = new CodexJsonRpcClient();
    client.onNotification((n) => this.handleNotification(live, n));
    client.onServerRequest((r) => this.handleServerRequest(live, r));
    client.onClose(() => this.handleClose(live));
    client.start({ cwd: live.cwd, codexHome: account.home });
    live.client = client;

    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
    client.notify("initialized");

    const resumeBase = buildThreadParams({
      cwd: live.cwd,
      permission: live.permission,
      model: live.model,
      configOverrides: this.contextConfigOverrides(),
      developerInstructions: live.developerInstructions,
    });
    await requestWithInstructionsFallback(resumeBase,
      (params) => this.resumeThread(client, threadId, found, account.home, params));
  }

  /**
   * Resume a thread from the rollout file we located, wherever it lives.
   *
   * The `path` matters because a rollout is written inside the CODEX_HOME of whichever
   * account served the turn, and this app-server is running on the account serving the
   * session NOW. Asked by thread id alone, it searches only its own home and answers "no
   * rollout found for thread id …" for a conversation that plainly exists — which is how
   * an account switch used to lose the history and open a brand-new thread instead.
   *
   * The id-only form is kept as a fallback for a codex build that predates `path`: there
   * the argument is rejected outright, and a resume that can still work by id should not
   * be downgraded into a new thread over a field name.
   */
  private async resumeThread(
    client: CodexJsonRpcClient,
    threadId: string,
    found: { path: string; sessionsDir: string },
    codexHome: string | undefined,
    resumeBase: CodexThreadParams,
  ): Promise<unknown> {
    const target = sessionsDirForHome(codexHome);
    const path = localizeRollout(found.path, found.sessionsDir, target);
    if (path !== found.path) {
      console.log(`[codex] thread=${threadId} rollout copied into the serving account's home to resume`);
    }
    return client.request("thread/resume", { threadId, path, ...resumeBase });
  }

  /** Read on connect/resume only; changing settings never interrupts a live turn. */
  private contextConfigOverrides(): { config?: Record<string, number> } {
    const providerConfig = this.config;
    const config: Record<string, number> = {};
    for (const key of ["model_context_window", "model_auto_compact_token_limit"] as const) {
      const value = providerConfig?.[key];
      if (value != null) config[key] = value;
    }
    return Object.keys(config).length ? { config } : {};
  }

  private async connect(sessionId: string, opts?: SendMessageOpts): Promise<LiveSession> {
    const meta = this.sessions.get(sessionId);
    const cwd = meta?.projectPath || getSessionProjectPath(sessionId) || process.cwd();
    const permission = permissionModeToCodex(opts?.permissionMode ?? this.config?.permission_mode, { designSession: opts?.designSession });
    const model = codexModel(opts?.model ?? this.config?.model);

    // Only resume a rollout attributable to this project. An unknown/resumed ID
    // without one must not silently become a fresh thread with a different identity.
    const found = locateRollout(sessionId, cwd);
    if (!found && !this.unstartedSessions.has(sessionId)) throw missingRolloutError(sessionId);

    const client = new CodexJsonRpcClient();
    const channel = createEventChannel();
    const live: LiveSession = {
      client, threadId: null, cwd, channel, permission, model,
      developerInstructions: opts?.designInstructions,
      pendingApprovals: new Map(), answeredCodexIds: new Set(),
      history: [], transcript: [], currentAssistant: "", currentEvents: [],
      pendingTurns: [], subagentThreadIds: new Set(),
    };
    this.live.set(sessionId, live);

    // Multi-account: resolve which codex account backs this session (sticky → strategy →
    // null = default ~/.codex). Spawn the app-server with that account's CODEX_HOME.
    const account = await resolveCodexAccountForSession(sessionId);

    client.onNotification((n) => this.handleNotification(live, n));
    client.onServerRequest((r) => this.handleServerRequest(live, r));
    client.onClose(() => this.handleClose(live));
    client.start({ cwd, codexHome: account?.home });

    await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
    client.notify("initialized");

    const resumeBase = buildThreadParams({
      cwd, permission, model,
      configOverrides: this.contextConfigOverrides(),
      developerInstructions: live.developerInstructions,
    });
    // Only treat as a resume when a rollout for this id is attributable to THIS
    // project (fail-closed cwd guard) — never resume another project's thread.
    const result = await requestWithInstructionsFallback(resumeBase, (params) => found
      ? this.resumeThread(client, sessionId, found, account?.home, params)
      : client.request("thread/start", params));

    const threadId = extractThreadId(result) ?? (found ? sessionId : null);
    if (!threadId) throw new Error("codex thread/start returned no thread id");
    this.unstartedSessions.delete(sessionId);
    live.threadId = threadId;

    if (threadId !== sessionId) {
      // Both ids stay mapped. The caller still holds the id it created the
      // session with, and dropping it here meant a follow-up sendMessage missed
      // and spawned a second app-server, while abortQuery found nothing to kill
      // and leaked the first.
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
    live.history = fromCodexSessionsDirs(threadId, (d) => {
      const msgs = getRolloutMessages(d, threadId, cwd);
      return msgs.length > 0 ? msgs : null;
    }) ?? [];
    return live;
  }

  private handleNotification(live: LiveSession, notif: JsonRpcNotification): void {
    // A quota refusal is an ordinary `error` notification, so it has to be recognised
    // before the mapper turns it into a plain error card in front of the user.
    if (notif.method === "error" && !live.rotating) {
      const reason = codexErrorMessage(notif.params);
      if (isCodexUsageLimit(reason) && this.beginRotation(live, reason)) return;
    }
    // Mid-rotation the subprocess behind this session is being replaced. Anything it still
    // emits describes the turn that was refused — including its `turn/completed`, which
    // would close the turn the caller is about to be given a second time.
    if (live.rotating) return;
    if (notif.method === "item/agentMessage/delta") {
      const d = (notif.params as { delta?: string })?.delta;
      if (typeof d === "string") live.currentAssistant += d;
    }
    if (notif.method === "thread/tokenUsage/updated") {
      const usage = parseTokenUsage(notif.params, live.model);
      if (usage) live.lastUsage = usage;
    }
    const notificationThreadId = threadIdFromNotification(notif.params);
    const parentToolUseId = notificationThreadId && live.subagentThreadIds.has(notificationThreadId)
      ? subagentCardId(notificationThreadId)
      : undefined;
    const events = mapCodexEvent(notif, live.threadId ?? "");
    for (const ev of events) {
      // The counts arrive on their own notification just before the turn ends,
      // so `done` is where they become visible to a consumer.
      if (ev.type === "done" && live.lastUsage) {
        ev.usage = live.lastUsage;
        this.recordTurnUsage(live, live.lastUsage);
      }
      const nested = parentToolUseId ? { ...ev, parentToolUseId } as ChatEvent : ev;
      live.channel.push(nested);
      // Accumulate tool calls into the turn so getMessages (live) keeps them.
      if (nested.type === "tool_use" || nested.type === "tool_result") live.currentEvents.push(nested);
      if (nested.type === "tool_use" && nested.tool === "Agent" && typeof nested.toolUseId === "string"
          && nested.toolUseId.startsWith("subagent-")) {
        live.subagentThreadIds.add(nested.toolUseId.slice("subagent-".length));
      }
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
      this.endTurn(live);
    }
    if (notif.method === "turn/started") {
      // Codex is the authority on whether the thread is busy — take the flag from
      // it rather than only from what this side believes it started.
      live.turnInFlight = true;
      const id = (notif.params as { turn?: { id?: string } })?.turn?.id;
      if (id) this.setActiveTurn(live, id);
    }
    // Manual /compact finished — codex signals via the contextCompaction item
    // (the thread/compacted notification is deprecated). Surface the compact-summary
    // marker inline so the chat UI offers "load previous conversation". The turn's
    // own turn/completed provides the `done`.
    if (notif.method === "item/completed" && live.compactRequested
        && (notif.params as { item?: { type?: string } })?.item?.type === "contextCompaction") {
      live.compactRequested = false;
      const file = fromCodexSessionsDirs(live.threadId ?? undefined,
        (d) => findRolloutByThreadId(d, live.threadId ?? "", live.cwd));
      if (file) {
        const content = `_Conversation compacted to save context._\n\nread the full transcript at: ${file}`;
        live.channel.push({ type: "text", content });
        // Keep the live transcript consistent so getMessages (live reload) also shows it.
        live.transcript.push({ id: `codex-compact-${live.threadId}`, role: "assistant", content, timestamp: new Date().toISOString() });
      }
    }
  }

  /** Persist Codex's per-turn token and prompt-cache split for the debug panel. */
  private recordTurnUsage(live: LiveSession, usage: import("../../shared/turn-usage.ts").TurnUsage): void {
    const accountId = live.threadId ? getSessionCodexAccount(live.threadId) ?? undefined : undefined;
    const account = accountId ? getCodexAccount(accountId) : null;
    try {
      insertTurnUsage({
        sessionId: live.threadId ?? "",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        contextWindow: usage.contextWindow,
        costUsd: usage.costUsd,
        // A cache miss alone does not prove a process restart: a first turn and
        // an evicted prompt cache look the same on the wire. Keep this false
        // until the provider has an explicit lifecycle reason to record.
        coldStart: false,
        ...(accountId ? { accountId } : {}),
        ...(account?.label ? { accountLabel: account.label } : {}),
      });
    } catch (err) {
      console.warn(`[usage] failed to persist codex usage: ${(err as Error).message}`);
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
    // A migrated session is reachable under both its original id and its thread
    // id; leaving either behind would hand out a dead session later.
    for (const [k, v] of this.live) if (v === live) this.live.delete(k);
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
    return fromCodexSessionsDirs(sessionId, (d) => {
      const msgs = getRolloutMessages(d, sessionId, cwd);
      return msgs.length > 0 ? msgs : null;
    }) ?? [];
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

    // Reuse the source session's already-running app-server when it's live (the
    // common edit case — the user was just chatting it). thread/fork copies a new
    // thread and thread/rollback targets that copy, so the source's live thread is
    // untouched. Avoids a ~10s cold `bun x @openai/codex app-server` spawn +
    // initialize handshake on every edit; only spawn a throwaway client as fallback.
    const liveSrc = this.live.get(sessionId);
    const reuse = !!liveSrc && !liveSrc.client.isClosed;
    const client = reuse ? liveSrc!.client : new CodexJsonRpcClient();
    try {
      if (!reuse) {
        client.start({ cwd });
        await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
        client.notify("initialized");
      }
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
      if (!reuse) client.close();
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
    if (!this.modelsPending) {
      this.modelsPending = this.loadModels().finally(() => { this.modelsPending = null; });
    }
    // A refresh must not block the picker once a successful list is available.
    if (this.modelsCache) return this.modelsCache.models;
    return this.modelsPending;
  }

  private async loadModels(): Promise<ModelOption[]> {
    const client = new CodexJsonRpcClient();
    try {
      // Without a CODEX_HOME the app-server falls back to the machine's own
      // ~/.codex login, which may be stale or absent — the model list then comes
      // from an account PPM does not use, or fails outright on a refresh error.
      const account = await resolveCodexAccountForSession();
      client.start({ cwd: process.cwd(), ...(account ? { codexHome: account.home } : {}) });
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
      client.notify("initialized");
      const all: unknown[] = [];
      let cursor: string | null = null;
      do {
        const res: ModelListResponse = await client.request<ModelListResponse>("model/list", { cursor }, CONTROL_REQUEST_TIMEOUT_MS);
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

  /**
   * The skills codex itself would resolve for `cwd`, asked of codex rather than
   * discovered from disk.
   *
   * Two reasons it has to come from the app-server. Codex's built-ins live under
   * `$CODEX_HOME/skills/.system/`, and PPM points CODEX_HOME at a per-account
   * directory — so scanning the ambient `~/.codex` reads a different, possibly
   * stale set than the session will actually run. And the app-server is the only
   * source of `enabled` and of the `interface` block (display name, icons) that
   * the picker shows.
   *
   * Cached briefly per (cwd, account): the list changes when the user installs a
   * skill, which should show up without a restart, but a picker keystroke must
   * not spawn an app-server.
   */
  invalidateSkillsCache(): void {
    this.skillsCache.clear();
  }

  async listSkills(sessionId?: string): Promise<CodexSkill[]> {
    const cwd = (sessionId ? getSessionProjectPath(sessionId) : null) || process.cwd();
    // Reuse the account already bound to the session; resolving afresh here
    // would advance a round-robin strategy for a mere UI listing.
    const accountId = sessionId ? getSessionCodexAccount(sessionId) : null;
    const home = (accountId ? getCodexAccount(accountId)?.home : null) ?? undefined;

    const key = `${cwd}\0${home ?? ""}`;
    const hit = this.skillsCache.get(key);
    if (hit && Date.now() < hit.expiry) return hit.skills;

    const client = new CodexJsonRpcClient();
    try {
      client.start({ cwd, codexHome: home });
      await client.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CAPABILITIES }, CONTROL_REQUEST_TIMEOUT_MS);
      client.notify("initialized");
      const skills = parseSkillList(await client.request("skills/list", {}, CONTROL_REQUEST_TIMEOUT_MS));
      if (skills.length > 0) this.skillsCache.set(key, { skills, expiry: Date.now() + SKILLS_CACHE_TTL });
      return skills;
    } catch {
      return [];
    } finally {
      client.close();
    }
  }

  /** Read the session's account without advancing the account-selection strategy. */
  async getUsage(sessionId?: string, pickedAccountId?: string): Promise<UsageInfo> {
    // Idempotent, and needed because a caller can reach the provider before the
    // server has started background polling — an unregistered source would make
    // the shared layer answer {} instead of reading codex.
    registerUsageSource(codexUsageSource);
    // An unopened chat has a claimed account but no session binding yet.
    // Read that exact account without advancing the selection strategy.
    const accountId = sessionId ? getSessionCodexAccount(sessionId) : pickedAccountId ?? null;
    const bound = accountId ? getCodexAccount(accountId) : null;
    if (bound) {
      // Through the shared layer, so this answers from the cache or the stored
      // snapshot and only reaches codex when nothing is known yet — the same
      // path Claude's usage takes. It used to spawn an app-server inline on
      // every miss, on the HTTP request's own thread of control.
      return {
        ...await getOrFetchUsage(this.id, bound.id),
        activeAccountId: bound.id,
        activeAccountLabel: bound.label,
      };
    }

    // No binding or explicit tab claim — a session binds on its first send. Name the account
    // that will serve it, but do NOT read its quota: that spawns an app-server
    // against a login which is not yet this session's, and which a round-robin
    // or lowest-usage pick may never hand it. So the toolbar can say WHO will
    // answer without PPM touching that account on a session's behalf before
    // the session owns it. Quota is read once a tab claims it or a session binds it.
    //
    // Skipped when the session names an account that no longer exists: naming
    // a different one there would be a lie about a binding that already failed.
    const pending = accountId ? null : peekCodexAccount();
    if (pending) return { activeAccountId: pending.id, activeAccountLabel: pending.label };

    // Managed accounts are assigned on first send; don't show an unrelated
    // ambient login while that assignment is pending or the binding is missing.
    //
    // Disabled ones do not count towards "managed accounts exist": with every one switched
    // off the selector returns null and chats really do run on the ambient ~/.codex login,
    // so that is the login whose usage belongs here.
    const selectable = listCodexAccounts().filter((a) => a.status !== "disabled");
    if (accountId || selectable.length > 0) return {};
    return getOrFetchUsage(this.id, AMBIENT_ACCOUNT_KEY);
  }
}
