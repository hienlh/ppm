import { validateReply } from "../../shared/chat-reply.ts";
import { encodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import { validateTurnRefs } from "../../shared/chat-turn-ref.ts";
import { recordTurnGrants } from "../../services/session-turns/turn-grant-ledger.ts";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { getSessionTitle, incrementSessionUnread, clearSessionUnread, getSessionUnreadCount, getSessionModel, setSessionModel, getSessionProvider, setSessionProvider, getSessionEffort, setSessionEffort, getSessionThinking, setSessionThinking, setSessionMigratedTo, resolveMigratedSession, getSessionDesignSlug, setSessionPermissionMode, getStoredPermissionModeAnyAlias, getLastTurnCacheState } from "../../services/db.service.ts";
import { describeApprovalInput } from "../../services/notification-format.ts";
import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import { VALID_EFFORT_VALUES, THINKING_ADAPTIVE, isThinkingEnabled } from "../../providers/claude-agent-sdk-query-options.ts";
import type { ChatWsClientMessage, SessionPhase } from "../../types/api.ts";
import type { TraceOrigin } from "../../shared/session-trace.ts";
// File watching and app-wide broadcasts are owned by the global WS (`./global.ts`)
// — a chat socket is not guaranteed to exist now that chat tabs mount lazily.
import { broadcastGlobalEvent } from "./global.ts";
import { bashOutputSpy } from "../../services/bash-output-spy.ts";
import { nestedSubagentSpy } from "../../services/nested-subagent-spy.ts";
import { resolveSessionDir } from "../../services/subagent-transcript-merger.ts";
import { backgroundShellRegistry } from "../../services/background-shell-registry.ts";
import { basename } from "node:path";
import { configService } from "../../services/config.service.ts";
import { prefixTokens } from "../../shared/turn-usage.ts";
import type { PromptCacheState } from "../../shared/prompt-cache-idle.ts";
import { isAsyncAgentLaunchAck, isTerminalAgentStatus } from "../../shared/background-agent-status.ts";
import { cacheReleaseDelayMs, selectWarmIdleEvictions } from "../../services/subprocess-retention.ts";
import { needsAuthServerNames } from "../../services/mcp-oauth/mcp-oauth-redirect.ts";
import { mcpStatusEvent, registerMcpSignInSync } from "./chat-mcp-sign-in-sync.ts";
import { refreshEffortStatus, sessionEffortStatus } from "./chat-effort-status.ts";
import type { EffortStatus } from "../../shared/effort-status.ts";
import { claudeTranscriptExists } from "../../services/claude-transcript-exists.ts";
import { extractAntigravitySessionTitle, findAntigravityTranscriptPath } from "../../providers/antigravity/antigravity-history.ts";
import { registerMemoryGauge } from "../../services/memory-diagnostics.ts";
import { setTabOpenDelivery, tabOpenBroker } from "../../services/tab-tools-mcp/tab-open-broker.ts";
import { setDbApprovalChat, type DbApprovalEvent } from "../../services/db-ai-tools/db-approval-broker.ts";
import { dbExecuteApprovalInput } from "../../shared/db-ai-tools.ts";
import { ppmApprovals } from "./chat-ppm-approvals.ts";
import { setCollabApprovalChat } from "../../services/session-collab/collab-approval-broker.ts";
import { collabWaits, setCollabIdleProbe } from "../../services/session-collab/collab-waits.ts";
import { collabSessionRenamed, collabTurnEnded } from "../../services/session-collab/collab-turn-events.ts";
import { isSpawned } from "../../services/session-collab/session-links.service.ts";
import type { LiveSessionState } from "../../services/session-collab/collab-context.ts";
import { collabApprovalTitle } from "../../services/notification-format.ts";
import {
  SESSION_COLLAB_APPROVAL_EVENT, sessionCollabApprovalInput,
  type SessionCollabAnswer, type SessionCollabApprovalEvent, type SessionCollabApprovalRequest,
} from "../../shared/session-collab.ts";
import { parseTabOpenResult, type TabOpenRequest } from "../../shared/tab-open-protocol.ts";
import { readLastTurnStop } from "../../services/session-trace/turn-stop-reader.ts";
import { describeTurnStop, type TurnStop } from "../../shared/turn-stop.ts";
import { createLogger } from "../../services/logger.ts";
import { dropStaleIdle, registerTokenRotation, type TokenRotationDeps } from "./chat-token-rotation.ts";
import { registerLeftoverSweeper } from "../../services/chat-session-processes/session-processes.service.ts";
import { setTurnRunningProbe } from "../../services/session-turns/session-turn-index.service.ts";
import type { SubprocessCredential } from "../../providers/claude-agent-sdk.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import { pairCounter } from "../../services/session-collab/pair-counter.ts";
import { applyQueueLifecycle, drainForDispatch, enqueueMessage, mergeEntries, queueState, sendQueuedNow, takeBackQueued, type QueuedEntry, type QueueDeps } from "./chat-message-queue.ts";

const log = createLogger("chat");
const bgShellLog = createLogger("bg-shell");

/**
 * How the session's last turn ended, when an error ended it. Told on every connect because
 * nothing in the transcript says so, and a reload otherwise shows a turn that just stops.
 * Never throws into the socket: without the trace the chat simply shows no stop bar.
 */
function lastTurnStop(sessionId: string): TurnStop | null {
  try {
    return readLastTurnStop(sessionId);
  } catch (e) {
    log.warn(`session=${sessionId} could not read how the last turn ended: ${(e as Error).message}`);
    return null;
  }
}

/** Resolve the SESSION's provider config — not the global default provider's.
 * Otherwise a non-default provider's chat (e.g. codex) would inherit claude's values. */
function sessionProviderConfig(sessionId: string) {
  const ai = configService.get("ai");
  const pid = activeSessions.get(sessionId)?.providerId
    ?? resolveStoredProvider(sessionId)
    ?? ai.default_provider ?? "claude";
  return ai.providers[pid];
}

/**
 * Which provider owns this session, stored answer first.
 *
 * `chatService.getSession` finds a session by scanning every provider's in-memory
 * map and returning the first hit, which is a guess: a provider that merely *tried*
 * to resume the id keeps an entry for it, and that entry then outranks the recorded
 * owner for as long as the process lives. That is how a claude session, once resumed
 * as codex by a NULL `provider_id`, stayed codex across reconnects and browser
 * reloads even after the row was corrected — only a restart cleared it.
 *
 * `session_metadata.provider_id` is written deliberately at creation, resume and
 * fork, so it is the authority; the scan stays as the fallback for a session created
 * in-process before the row exists.
 *
 * Between the two, a claude transcript on disk settles an empty row — the unread upsert
 * creates rows with no provider, and the scan can name codex for a claude id it merely
 * tried to resume. The answer is persisted so routes and restarts agree with it.
 */
function resolveStoredProvider(sessionId: string): string | undefined {
  const stored = getSessionProvider(sessionId);
  if (stored) return stored;
  if (claudeTranscriptExists(sessionId)) {
    try { setSessionProvider(sessionId, "claude"); } catch { /* non-fatal */ }
    return "claude";
  }
  if (findAntigravityTranscriptPath(sessionId)) {
    try { setSessionProvider(sessionId, "antigravity"); } catch { /* non-fatal */ }
    return "antigravity";
  }
  return chatService.getSession(sessionId)?.providerId;
}

/**
 * Adopt the tab's provider when nothing is stored. `session_metadata` rows are written
 * by whichever upsert runs first, and the account claim's leaves `provider_id` NULL —
 * after which the global default decides, so a claude session on a codex-default install
 * resumes as codex and every message dies with "transcript was not found". Persisting the
 * hint fixes the session for good, including the paths (routes, restarts) that never see
 * this socket. Only a provider this server has registered is accepted.
 */
function adoptProviderHint(sessionId: string, hint: string | undefined): void {
  if (!hint || !providerRegistry.get(hint) || getSessionProvider(sessionId)) return;
  try { setSessionProvider(sessionId, hint); } catch { /* non-fatal */ }
}

/** Resolve the model shown in session_state: per-session override, else provider default. */
function resolveSessionModel(sessionId: string): string | undefined {
  return getSessionModel(sessionId) ?? sessionProviderConfig(sessionId)?.model;
}

/** Resolve the effort shown in session_state: per-session override, else provider default. */
function resolveSessionEffort(sessionId: string): string | undefined {
  return getSessionEffort(sessionId) ?? sessionProviderConfig(sessionId)?.effort;
}

/** What overrides the effort shown in session_state, if anything does. */
function resolveEffortStatus(sessionId: string, entry: SessionEntry): EffortStatus | null {
  return sessionEffortStatus(providerRegistry.get(entry.providerId), entry, resolveSessionModel(sessionId));
}

/** Whether thinking is effectively ON: per-session override wins, else provider config, else SDK default. */
function resolveSessionThinkingEnabled(sessionId: string): boolean {
  return isThinkingEnabled(
    getSessionThinking(sessionId),
    sessionProviderConfig(sessionId)?.thinking_budget_tokens,
  );
}

const GENERIC_SESSION_TITLES = new Set(["Chat", "Resumed Chat"]);

function isGenericSessionTitle(title: string | undefined | null, providerId?: string): boolean {
  if (!title) return true;
  if (GENERIC_SESSION_TITLES.has(title)) return true;
  if (providerId === "antigravity" && title === "New Chat") return true;
  return false;
}

/** Resolve a real display title without leaking placeholder titles like "Resumed Chat". */
function resolveDisplaySessionTitle(sessionId: string, providerId?: string, inMemoryTitle?: string): string | null {
  const dbTitle = getSessionTitle(sessionId);
  if (dbTitle && !isGenericSessionTitle(dbTitle, providerId)) return dbTitle;
  if (inMemoryTitle && !isGenericSessionTitle(inMemoryTitle, providerId)) return inMemoryTitle;
  if (providerId === "antigravity") {
    const agyTitle = extractAntigravitySessionTitle(sessionId);
    if (agyTitle) return agyTitle;
  }
  return null;
}

const PING_INTERVAL_MS = 5_000; // Detect an active stream gap promptly through a tunnel.
/**
 * When an abandoned session's entry is dropped.
 *
 * Deliberately *not* derived from the cache window. This timer also drops `activeSessions`
 * — which carries up to MAX_TURN_EVENTS buffered events per session, tool results included —
 * plus team watchers and the background-shell registry. Stretching it to the cache window
 * held all of that for an hour to protect a subprocess it knows nothing about.
 *
 * It still must not preempt `scheduleSubprocessRelease`, so when that release is pending the
 * timer reschedules itself instead of running. The two stay independent, and the long wait
 * happens only for sessions that actually have a warm subprocess to protect.
 */
const CLEANUP_TIMEOUT_MS = 5 * 60_000;
/**
 * How many clientless sessions may hold a live SDK subprocess at once.
 *
 * This, not the retention window, is what bounds the memory: a longer window keeps these
 * slots filled for longer but never adds a slot. At ~350MB per subprocess, 10 costs ~3.5GB.
 */
const MAX_WARM_IDLE_SESSIONS = 10;
const MAX_TURN_EVENTS = 10_000; // memory safety cap
/** How much of the final answer is kept for the notification that quotes it. */
const FINAL_TEXT_KEEP = 1_000;
/**
 * Share of the turn buffer nested-agent children may take. They are restored
 * from disk on reload anyway; this only keeps a chatty grandchild from evicting
 * the turn's own later events out of a reconnecting client's replay.
 */
const MAX_NESTED_TURN_EVENTS = 2_000;
const BUFFERABLE_TYPES = new Set([
  "text", "thinking", "tool_use", "tool_result",
  "approval_request", "error", "done", "account_info", "account_retry",
  "team_detected",
]);

export type ChatWsSocket = {
  /** `origin` is set only by an in-process caller (a script schedule); a browser socket leaves it unset, i.e. `ws`. */
  data: { type: string; sessionId: string; projectName?: string; providerHint?: string; origin?: TraceOrigin };
  send: (data: string) => void;
  ping?: (data?: string | ArrayBuffer) => void;
};

export interface SessionEntry {
  providerId: string;
  clients: Set<ChatWsSocket>;
  projectPath?: string;
  projectName?: string;
  pingIntervals: Map<ChatWsSocket, ReturnType<typeof setInterval>>;
  phase: SessionPhase;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  pendingApprovalEvent?: { type: string; requestId: string; tool: string; input: unknown };
  /** Provider approvals that arrived while another held the slot — parallel tool calls, such as
   *  two AskUserQuestion in one message. Each is shown (and only then sent) once the one before
   *  it is answered (`showNextApproval`). */
  queuedApprovals?: { type: string; requestId: string; tool: string; input: unknown }[];
  turnEvents: unknown[];
  /** The opening of the turn's last top-level text block — the answer a "Chat completed" notification quotes. */
  finalText?: string;
  /** The last finished turn's `finalText`, kept for `session_status` after the notification took it. */
  lastAnswer?: string;
  /** The user message that initiated the current turn (for reconnect replay) */
  currentUserMessage?: string;
  /** The sending browser's own id for that message, so a reconnect replay keeps it bound to its turn. */
  currentClientMessageId?: string;
  /** Messages a person sent while a turn ran, not yet read by the AI (`chat-message-queue.ts`). */
  queue?: QueuedEntry[];
  streamPromise?: Promise<void>;
  permissionMode?: string;
  /** Per-session model override; falls back to provider default when undefined */
  model?: string;
  /** Whether the persistent event consumer loop is running */
  isStreamingActive: boolean;
  /** Active team watchers keyed by team name */
  teamWatchers: Map<string, { cleanup: () => void }>;
  /** Set of detected team names for this session */
  teamNames: Set<string>;
  /** toolUseId of a pending TeamCreate call */
  pendingTeamCreate?: string;
  /** Throttle marker for the filesystem probe that finds implicitly-created teams */
  lastImplicitTeamProbe?: number;
  /** Compact indicator state — sticky until turn ends or boundary received, synced on reconnect */
  compactStatus?: "compacting" | null;
  /** MCP servers the subprocess reported as `needs-auth` at init — drives the chat's sign-in bar */
  mcpNeedsAuth?: string[];
  /** What the subprocess said at the last turn's start about the effort it sends — see chat-effort-status.ts */
  effortStatus?: EffortStatus;
  /** toolUseIds of Bash/Agent calls launched with run_in_background — their spy outlives the tool_result */
  backgroundToolUseIds?: Set<string>;
  /** Nested-agent children buffered into turnEvents this turn (see MAX_NESTED_TURN_EVENTS) */
  nestedBuffered?: number;
  /** Monotonic sequence for streamed events, used to detect a downstream content gap. */
  streamSeq: number;
  /** When the last client left, for evicting the least recently used warm subprocess */
  idleSince?: number;
  /** When the last turn completed — the moment this session's prompt cache was last written */
  lastTurnEndedAt?: number;
  /** Transcript replayed to the API on that turn — what re-caching it would cost again */
  lastTurnPrefixTokens?: number;
  /** Context that turn actually held, measured per API call rather than summed */
  lastTurnContextTokens?: number;
  /** Cache window the API reported on that turn, outranking the credential-shaped guess */
  lastTurnCacheTtlMs?: number;
  /** A compaction the last turn ended on, which leaves the cached prefix inapplicable */
  lastTurnCompactedAt?: number;
  /**
   * When the message that opened the current turn reached the server — what "time to first
   * event" is measured from. The consumer loop outlives turns, so its own clock would count
   * the idle gap before a follow-up as waiting on the provider.
   */
  turnRequestedAt?: { at: number; cold: boolean };
  /**
   * The latest turns a sent message opened, newest last (`turn_started`). Kept past the turn, in
   * every greeting, so a device that joins later can still tell which turn its message became.
   */
  turnBindings?: TurnBinding[];
  /** Pending release of the subprocess once its prompt cache lapses */
  cacheReleaseTimer?: ReturnType<typeof setTimeout>;
  /** The socket whose message opened the latest turn: where the AI's tab tools open a tab. */
  lastSender?: ChatWsSocket;
  /** Events broadcast with no client attached since the session last went idle — logged then, as one count. */
  droppedEvents?: number;
  /**
   * Created by the server for a message no browser sent (another session's AI) and joined by no
   * browser since. Such a session's consumer loop outlives its turns like any other, so between
   * turns it counts as idle for the warm-subprocess cap and the cache-expiry release — otherwise
   * nothing would ever free its subprocess, since those run only when a browser socket leaves.
   */
  socketless?: boolean;
}

/**
 * Whether nothing is running in the session right now: no consumer loop, or a socketless session
 * between turns with no approval and no background work.
 */
function idleBetweenTurns(sessionId: string, entry: SessionEntry): boolean {
  if (!entry.isStreamingActive) return true;
  return !!entry.socketless && entry.phase === "idle" && !entry.pendingApprovalEvent && !hasBackgroundWork(sessionId);
}

/** Sessions with no client attached, not mid-turn, still holding a live subprocess. */
function listWarmIdleSessions(): { sessionId: string; entry: SessionEntry; idleSince?: number }[] {
  const out: { sessionId: string; entry: SessionEntry; idleSince?: number }[] = [];
  for (const [sessionId, entry] of activeSessions) {
    if (entry.clients.size > 0 || !idleBetweenTurns(sessionId, entry)) continue;
    const provider = providerRegistry.get(entry.providerId);
    if (!provider?.hasStreamingSession?.(sessionId)) continue;
    out.push({ sessionId, entry, idleSince: entry.idleSince });
  }
  return out;
}

/** Release a session's subprocess, if it still has one and nobody is using it. */
function releaseSubprocess(sessionId: string, reason: string, note: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  // Disarm before deciding anything: past this point the pending release is either being
  // performed or is moot, and a timer left armed is not merely stale. startCleanupTimer
  // reschedules itself while `cacheReleaseTimer` is set, so an entry evicted by
  // enforceWarmIdleCap — which calls straight in here — would outlive its own subprocess by
  // up to the full TTL, holding its turnEvents buffer, ping interval, team watchers and
  // shell registry. That is the accumulation the 5-minute cleanup exists to stop, on the one
  // path that only runs when memory is already tight. Clearing here covers every caller.
  if (entry.cacheReleaseTimer) {
    clearTimeout(entry.cacheReleaseTimer);
    entry.cacheReleaseTimer = undefined;
  }
  if (entry.clients.size > 0 || !idleBetweenTurns(sessionId, entry)) return;
  const provider = providerRegistry.get(entry.providerId);
  if (!provider?.hasStreamingSession?.(sessionId)) return;
  chatService.abortQuery(entry.providerId, sessionId, reason, "ws");
  log.info(`session=${sessionId} released subprocess (${reason}): ${note}`);
}

/**
 * Drop a session's live subprocess so its next turn is rebuilt from what is on disk.
 *
 * Two kinds of caller need this, both because the subprocess holds state that a change
 * made behind its back cannot reach. A route that rewrites the JSONL: the user strips an
 * oversized image, sends again, and the same image is re-sent from memory and fails
 * identically. And a codex account switch: the app-server was spawned with one account's
 * CODEX_HOME and keeps serving that account no matter what the session's binding now says.
 *
 * `listRunningSessions()` does not cover either case — that skips `phase === "idle"`, and a
 * warm idle subprocess is exactly what both are about. Unlike `releaseSubprocess` this does
 * not require the session to be clientless, because having the tab open is the normal way
 * to reach both buttons.
 */
export function dropIdleSubprocess(sessionId: string, reason: string, note: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  const provider = providerRegistry.get(entry.providerId);
  if (!provider?.hasStreamingSession?.(sessionId)) return;
  chatService.abortQuery(entry.providerId, sessionId, reason, "ws");
  if (entry.cacheReleaseTimer) {
    clearTimeout(entry.cacheReleaseTimer);
    entry.cacheReleaseTimer = undefined;
  }
  log.info(`session=${sessionId} released subprocess (${reason}): ${note}`);
}

/** Whether a background agent or shell the session started is still running in its subprocess. */
export function hasBackgroundWork(sessionId: string): boolean {
  if ((activeSessions.get(sessionId)?.backgroundToolUseIds?.size ?? 0) > 0) return true;
  return backgroundShellRegistry.list(sessionId).some((sh) => sh.status !== "stopped");
}

/** Tear down the longest-idle subprocesses once too many sessions are holding one. */
function enforceWarmIdleCap(): void {
  const warmIdle = listWarmIdleSessions();
  for (const sessionId of selectWarmIdleEvictions(warmIdle, MAX_WARM_IDLE_SESSIONS)) {
    releaseSubprocess(
      sessionId,
      "warm_idle_cap",
      `Subprocess released early: more than ${MAX_WARM_IDLE_SESSIONS} idle sessions were holding one`,
    );
  }
}

/**
 * Schedule the subprocess release for when this session's prompt cache lapses.
 *
 * Timed from the last completed turn rather than from the disconnect: the cache clock started
 * when the turn was sent, so a session whose last turn is already older than the TTL has
 * nothing left to protect and its subprocess goes at once.
 */
function scheduleSubprocessRelease(sessionId: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  if (entry.cacheReleaseTimer) clearTimeout(entry.cacheReleaseTimer);
  entry.cacheReleaseTimer = undefined;

  const provider = providerRegistry.get(entry.providerId);
  if (!provider?.hasStreamingSession?.(sessionId)) return;

  const note = "Subprocess released: its prompt cache has expired, so keeping it warm saves nothing";
  // The window is the provider's to state: an API-key install's cache dies at five minutes,
  // so holding the subprocess for an hour there guards nothing and costs ~350MB.
  // The API's own answer where the turn gave one, the provider's inference otherwise: an
  // install wrongly read as API-key would drop a subprocess at minute five and pay to rebuild
  // a prefix whose cache had fifty-five minutes left. Entry-only, with no DB lookup — a
  // session with no turn in this process has no `lastTurnEndedAt` either, so the delay is 0
  // regardless of the window.
  const ttlMs = entry.lastTurnCacheTtlMs ?? provider.promptCacheTtlMs?.(sessionId);
  const delay = cacheReleaseDelayMs(entry.lastTurnEndedAt, Date.now(), ttlMs);
  if (delay === 0) {
    releaseSubprocess(sessionId, "cache_expired", note);
    return;
  }
  entry.cacheReleaseTimer = setTimeout(() => {
    const e = activeSessions.get(sessionId);
    if (e) e.cacheReleaseTimer = undefined;
    releaseSubprocess(sessionId, "cache_expired", note);
  }, delay);
}

/**
 * What a reconnecting client needs to say whether this session's prompt cache is still warm.
 *
 * The three facts are only known here: when the cache was last written, how long this
 * install's caches live, and how much transcript would have to be re-sent. The browser has
 * none of them after a reload — `ChatMessage.usage` is attached from the live `done` event
 * and is not in the transcript — so a tab reopened the next morning would otherwise have no
 * way to warn that the first message of the day is the expensive one.
 *
 * Null until a turn has both completed and reported its usage: with nothing cached there is
 * nothing to lose, and a size PPM cannot measure must not be guessed at.
 */
function promptCacheSnapshot(sessionId: string, entry: SessionEntry): PromptCacheState | null {
  const provider = providerRegistry.get(entry.providerId);
  const declaredTtlMs = provider?.promptCacheTtlMs?.(sessionId);
  // A provider with no opinion has no Anthropic prompt cache to warn about. Asked before the
  // measured window is consulted, because this gate is about whether there is a cache at all.
  if (declaredTtlMs == null) return null;

  // The entry is memory, and memory is the short-lived half of this. `CLEANUP_TIMEOUT_MS`
  // drops it five minutes after the last tab leaves, and a restart drops it at once — both
  // well inside the hour the cache it describes actually lives. So a session reopened later
  // has to answer from `turn_usage`, which recorded the same three facts on every turn.
  // Memory still wins when it has them: it is this process's own turn, with no clock
  // conversion between here and SQLite's UTC text.
  const persisted = entry.lastTurnEndedAt == null ? getLastTurnCacheState(sessionId) : null;
  const lastTurnEndedAt = entry.lastTurnEndedAt ?? persisted?.endedAtMs;
  const billedPrefixTokens = entry.lastTurnPrefixTokens ?? persisted?.prefixTokens;
  const contextTokens = entry.lastTurnContextTokens ?? persisted?.contextTokens;
  // `usage.cache_creation` beats the guess `promptCacheTtlMs` makes from the credential's
  // shape, which is wrong for a proxy, a custom base_url, or a subscription past its limits.
  const ttlMs = entry.lastTurnCacheTtlMs ?? persisted?.cacheTtlMs ?? declaredTtlMs;
  // Memory first again, and here that matters in the other direction: a live entry that has
  // re-cached since holds `undefined`, which must beat the stale compaction still on the
  // row this session's last turn wrote.
  const compactedAt = entry.lastTurnEndedAt != null ? entry.lastTurnCompactedAt : persisted?.compactedAt;

  return {
    ttlMs,
    // Sent even before a turn has completed: the window is the install's, and a tab that
    // stays connected all day needs it to arm the notice from its own turns.
    ...(lastTurnEndedAt != null && { lastTurnEndedAt }),
    ...(billedPrefixTokens != null && { billedPrefixTokens }),
    ...(contextTokens != null && { contextTokens }),
    ...(compactedAt != null && { compactedAt }),
  };
}

/** Push the current background-shell registry snapshot to a session's clients. */
function broadcastBackgroundRegistry(sessionId: string): void {
  broadcast(sessionId, {
    type: "background_registry",
    sessionId,
    shells: backgroundShellRegistry.list(sessionId),
  });
}

/** Tracks active sessions — persists even when FE disconnects */
const activeSessions = new Map<string, SessionEntry>();
registerMemoryGauge("chat.activeSessions", () => activeSessions.size);
registerMemoryGauge("chat.turnEvents", () => {
  let n = 0;
  for (const e of activeSessions.values()) n += e.turnEvents.length;
  return n;
});
registerMemoryGauge("chat.clients", () => {
  let n = 0;
  for (const e of activeSessions.values()) n += e.clients.size;
  return n;
});

registerMcpSignInSync({
  sessions: () => activeSessions.entries(),
  broadcast: (sessionId, event) => broadcast(sessionId, event),
  reconnect: async (providerId, sessionId, serverName) => {
    const provider = providerRegistry.get(providerId) as { reconnectMcpServer?: (s: string, n: string) => Promise<string | null> } | undefined;
    return provider?.reconnectMcpServer?.(sessionId, serverName) ?? null;
  },
  // Background agents and shells outlive the turn inside the subprocess; a sign-in elsewhere
  // must never be what kills them.
  canDrop: (sessionId) => {
    const entry = activeSessions.get(sessionId);
    if (!entry || entry.isStreamingActive) return false;
    return !hasBackgroundWork(sessionId);
  },
  dropIdle: (sessionId, serverName) => dropIdleSubprocess(
    sessionId,
    "mcp_sign_in",
    `Subprocess released: it could not see the new ${serverName} sign-in, the next turn starts a fresh one`,
  ),
});

const tokenRotationDeps: TokenRotationDeps = {
  liveSubprocesses: () => {
    const provider = providerRegistry.get("claude") as {
      liveSubprocessCredentials?: () => Array<{ sessionId: string; credential: SubprocessCredential }>;
    } | undefined;
    return (provider?.liveSubprocessCredentials?.() ?? []).map(({ sessionId, credential }) => {
      const entry = activeSessions.get(sessionId);
      // The consumer loop outlives each turn, so a live subprocess between turns sits at
      // `idle` with `isStreamingActive` still set. A subprocess with no entry here belongs to
      // something else (a scheduled run) and is never ours to judge idle.
      const busy = !entry || entry.phase !== "idle" || !!entry.pendingApprovalEvent || hasBackgroundWork(sessionId);
      return { sessionId, credential, busy };
    });
  },
  dropIdle: (sessionId) => dropIdleSubprocess(
    sessionId,
    "token_rotated",
    "Subprocess restarted: its account's sign-in token was renewed, the next message resumes on the new one",
  ),
};
registerTokenRotation(tokenRotationDeps);

/**
 * Whether a session is working, for the sweep that stops what a chat left running once it has been
 * idle long enough. Busy is a turn running through any door, an approval waiting, or background
 * work still in the subprocess. An open socket is not activity: a closed tab or a backgrounded phone
 * must not start the countdown on a turn that is still running.
 */
export function leftoverSessionActivity(sessionId: string): { busy: boolean; lastActiveAt?: number } {
  const run = chatService.turnActivity(sessionId);
  const entry = activeSessions.get(sessionId);
  const busy = run.running
    || (!!entry && (entry.phase !== "idle" || !!entry.pendingApprovalEvent || hasBackgroundWork(sessionId)));
  const last = Math.max(run.lastEndedAt ?? 0, entry?.lastTurnEndedAt ?? 0);
  return { busy, lastActiveAt: last || undefined };
}

registerLeftoverSweeper({
  activity: leftoverSessionActivity,
});

/**
 * Sessions with a turn in flight, optionally narrowed to one project.
 *
 * Exists because the frontend only learns a session's phase by connecting to its
 * WebSocket, which requires the chat tab to be mounted. Tabs mount lazily, so a
 * background turn would otherwise show no spinner in the tab strip and no
 * indicator in the document title. Reads the in-memory registry only — no DB.
 */
export function listRunningSessions(
  projectName?: string,
): { sessionId: string; phase: SessionPhase; projectName: string }[] {
  const running: { sessionId: string; phase: SessionPhase; projectName: string }[] = [];
  for (const [sessionId, entry] of activeSessions) {
    if (entry.phase === "idle") continue;
    if (projectName && entry.projectName !== projectName) continue;
    running.push({ sessionId, phase: entry.phase, projectName: entry.projectName ?? "" });
  }
  return running;
}

/** The registry entry for any id the session has been known by. */
function entryOf(sessionId: string): SessionEntry | undefined {
  return activeSessions.get(sessionId) ?? activeSessions.get(resolveMigratedSession(sessionId));
}

/**
 * What the session tools may know of a session open in this process, or null when it is not open:
 * read from the registry only, never from a transcript.
 */
export function collabLiveState(sessionId: string): LiveSessionState | null {
  const entry = entryOf(sessionId);
  if (!entry) return null;
  const pending = entry.pendingApprovalEvent;
  return {
    providerId: entry.providerId,
    ...(entry.projectName ? { projectName: entry.projectName } : {}),
    ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
    phase: entry.phase,
    ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    waitingFor: !pending ? null : pending.tool === "AskUserQuestion" ? "question" : "approval",
    ...(entry.lastAnswer ? { lastAnswer: entry.lastAnswer } : {}),
    updatedAt: entry.phase !== "idle" ? Date.now() : entry.lastTurnEndedAt ?? entry.turnRequestedAt?.at,
    ...(entry.turnBindings?.length ? { currentTurnId: entry.turnBindings[entry.turnBindings.length - 1]!.turnId } : {}),
  };
}
setCollabIdleProbe((sessionId) => (entryOf(sessionId)?.phase ?? "idle") === "idle");

/**
 * App-wide broadcasts live on the global bus (`/ws/global`), not on chat sockets:
 * chat tabs mount lazily, so a chat socket is not guaranteed to exist. Re-exported
 * here because routes and services already import it from this module.
 */
export { broadcastGlobalEvent } from "./global.ts";

/** Project names already reported as unregistered: a tab reconnects often, and the news is once. */
const reportedUnregisteredProjects = new Set<string>();

/** A chat socket named a project that is not registered, so the session runs with no project path. */
function reportUnregisteredProject(sessionId: string, projectName: string): void {
  const line = `session=${sessionId} project '${projectName}' not registered — running without project path`;
  if (reportedUnregisteredProjects.has(projectName)) {
    log.debug(line);
    return;
  }
  reportedUnregisteredProjects.add(projectName);
  log.warn(line);
}

/** Remove a client from the session, cleaning up its ping interval */
function evictClient(entry: SessionEntry, ws: ChatWsSocket): void {
  clearClientPing(entry, ws);
  entry.clients.delete(ws);
  if (entry.lastSender === ws) entry.lastSender = undefined;
}

/**
 * Hands an AI tab tool's request to the device that sent the turn's message or, when that
 * one has gone (a locked phone, a closed laptop), to every device showing the chat; the
 * first answer settles the call. Never buffered into `turnEvents`: a device that reconnects
 * later must not open the tab again. Returns how many sockets it went to.
 */
function deliverTabOpen(sessionId: string, request: TabOpenRequest): number {
  const entry = activeSessions.get(sessionId);
  if (!entry) return 0;
  const json = JSON.stringify(request);
  const sendTo = (clients: Iterable<ChatWsSocket>): number => {
    let sent = 0;
    for (const client of [...clients]) {
      try { client.send(json); sent++; } catch { evictClient(entry, client); }
    }
    return sent;
  };
  if (entry.lastSender && entry.clients.has(entry.lastSender) && sendTo([entry.lastSender]) > 0) return 1;
  return sendTo(entry.clients);
}
setTabOpenDelivery(deliverTabOpen, resolveMigratedSession);

/**
 * A request for the user's answer is pending — a provider's own approval or question, or a
 * `db_execute` from PPM's database tools: held for devices that connect later
 * (`session_state.pendingApproval`), marked unread on every device and sent as a notification.
 */
function holdApprovalRequest(sessionId: string, entry: SessionEntry, ev: { type: string; requestId: string; tool: string; input: unknown }): void {
  entry.pendingApprovalEvent = ev;

  const isQuestion = ev.tool === "AskUserQuestion";
  const collab = sessionCollabApprovalInput(ev.tool, ev.input);
  const nType = isQuestion ? "question" : collab ? "collab_approval" : "approval_request";
  // Persist unread to DB + broadcast to all tabs/devices
  const approvalSession = chatService.getSession(sessionId);
  incrementSessionUnread(sessionId, nType, approvalSession?.title, entry.projectName || null);
  broadcastGlobalEvent({ type: "session:unread_changed", sessionId, unreadCount: -1, unreadType: nType, projectName: entry.projectName || "", sessionTitle: approvalSession?.title || null });

  import("../../services/notification.service.ts").then(({ notificationService }) => {
    const project = entry.projectName || "Project";
    const session = chatService.getSession(sessionId);
    const sTitle = session?.title || `Session ${sessionId.slice(0, 8)}`;
    const title = isQuestion ? "AI has a question" : collab ? collabApprovalTitle(collab) : "Waiting for approval";
    const db = dbExecuteApprovalInput(ev.tool, ev.input);
    const body = isQuestion || collab
      ? `${project} — ${sTitle}`
      : db ? `${project} — AI wants to change ${db.connectionName}` : `${project} — ${ev.tool} needs permission`;
    notificationService.broadcast(nType, {
      title, body, project: entry.projectName || "", sessionId, providerId: entry.providerId, sessionTitle: sTitle, tool: ev.tool,
      ...describeApprovalInput(ev.tool, ev.input),
    }, {
      // Answered, or looked at, on any device since — either way it needs no alert.
      stillUnseen: () => entry.pendingApprovalEvent?.requestId === ev.requestId && getSessionUnreadCount(sessionId) > 0,
    });
  }).catch(() => {});
}

/**
 * PPM's own approvals — a `db_execute` change (`db-approval-broker.ts`) and the session tools'
 * cards (`collab-approval-broker.ts`) — ask the user here. Not buffered into the turn's replay: the
 * tool call's own card already shows what is asked, and a device that connects later reads the
 * approval from `session_state.pendingApproval`. Answered over HTTP, never over this socket.
 */
function announcePpmApproval(sessionId: string, event: { type: string; requestId: string; tool: string; input: unknown }): boolean {
  const entry = activeSessions.get(sessionId);
  if (!entry) return false;
  // Another approval holds the session's one slot: this one waits behind it
  // (`showWaitingPpmApproval`) rather than taking that card off the user's screen.
  if (entry.pendingApprovalEvent) return true;
  holdApprovalRequest(sessionId, entry, event);
  broadcast(sessionId, event);
  return true;
}

/** One of PPM's own approvals was answered, or given up on: every device drops its card. */
function ppmApprovalResolved(sessionId: string, requestId: string, approved: boolean, answer?: SessionCollabAnswer | null): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  broadcast(sessionId, { type: "approval_resolved", requestId, approved, answers: answer ? { answer } : null });
  if (entry.pendingApprovalEvent?.requestId === requestId) clearPendingApproval(sessionId, entry);
  broadcast(sessionId, { type: "phase_changed", phase: entry.phase });
}
setDbApprovalChat({
  announce: (sessionId, event: DbApprovalEvent) => announcePpmApproval(sessionId, event),
  resolved: (sessionId, requestId, approved) => ppmApprovalResolved(sessionId, requestId, approved),
}, resolveMigratedSession);

/** A session tool's card appeared in, or left, a session: the tracking bar follows it app-wide. */
function collabApprovalGlobal(sessionId: string, event: Omit<SessionCollabApprovalEvent, "type" | "projectName" | "sessionId">): void {
  const projectName = activeSessions.get(sessionId)?.projectName ?? "";
  broadcastGlobalEvent({ type: SESSION_COLLAB_APPROVAL_EVENT, projectName, sessionId, ...event } satisfies SessionCollabApprovalEvent);
}
setCollabApprovalChat({
  announce: (sessionId, event: SessionCollabApprovalRequest) => {
    const shown = announcePpmApproval(sessionId, event);
    if (shown) collabApprovalGlobal(sessionId, { requestId: event.requestId, state: "pending", input: event.input });
    return shown;
  },
  resolved: (sessionId, requestId, answer) => {
    ppmApprovalResolved(sessionId, requestId, answer === "allow_once" || answer === "allow_session", answer);
    collabApprovalGlobal(sessionId, { requestId, state: "resolved", ...(answer ? { answer } : {}) });
  },
}, resolveMigratedSession);

/**
 * A provider asks for an approval or an answer. The session has one slot and every device shows
 * one card, so a request arriving while another provider request holds it waits its turn: shown
 * there, a second AskUserQuestion of the same message replaced the first card, and once it was
 * answered nothing could answer the first — the turn waited on it for good. PPM's own approvals
 * (a `db_execute`, a session tool's card) do give way, since each waits in its broker and comes
 * back (`showWaitingPpmApproval`).
 */
function receiveApprovalRequest(sessionId: string, entry: SessionEntry, ev: { type: string; requestId: string; tool: string; input: unknown }): void {
  const holder = entry.pendingApprovalEvent;
  if (holder && holder.requestId !== ev.requestId && !ppmApprovals.has(holder.requestId)) {
    (entry.queuedApprovals ??= []).push(ev);
    log.info(`session=${sessionId} approval ${ev.requestId} (${ev.tool}) queued behind ${holder.requestId}`);
    return;
  }
  holdApprovalRequest(sessionId, entry, ev);
  bufferAndBroadcast(sessionId, ev);
}

/**
 * The slot is empty: the next provider request waiting in line is shown, else one of PPM's own
 * approvals that a provider's had taken the slot from.
 */
function showNextApproval(sessionId: string, entry: SessionEntry): void {
  if (entry.pendingApprovalEvent) return;
  const next = entry.queuedApprovals?.shift();
  if (next) {
    holdApprovalRequest(sessionId, entry, next);
    bufferAndBroadcast(sessionId, next);
    return;
  }
  showWaitingPpmApproval(sessionId, entry);
}

/**
 * Another approval took the session's one pending slot while one of PPM's own was waiting, and
 * has now been answered: PPM's approval is shown again.
 */
function showWaitingPpmApproval(sessionId: string, entry: SessionEntry): void {
  const waiting = ppmApprovals.pendingEvent(sessionId);
  if (!waiting || entry.pendingApprovalEvent) return;
  holdApprovalRequest(sessionId, entry, waiting);
  broadcast(sessionId, waiting);
}

/** What the AI hears when one of PPM's approvals is still waiting as the turn ends. */
const DB_APPROVAL_TURN_OVER = "The turn ended before the user answered, so nothing ran.";

/**
 * Empties the session's one approval slot. The next request in line is shown in its place
 * (`showNextApproval`), or, given a reason, everything still waiting is declined first: the user
 * moved on, or the turn the calls belong to is over. Every place that empties the slot comes
 * through here, so none can leave a request waiting for a card nobody sees.
 */
function clearPendingApproval(sessionId: string, entry: SessionEntry, cancelReason?: string): void {
  // Emptied first. Cancelling a PPM approval settles its broker, whose `resolved` comes back
  // through `ppmApprovalResolved`; with the slot still holding it, that inner call would show the
  // next queued request and this one would then blank the slot over it, leaving that request
  // with no card and its turn waiting for good.
  entry.pendingApprovalEvent = undefined;
  if (cancelReason) {
    ppmApprovals.cancelSession(sessionId, cancelReason);
    declineQueuedApprovals(sessionId, entry, cancelReason);
  }
  showNextApproval(sessionId, entry);
}

/**
 * Declines the provider requests still in line. Dropping them without an answer is the hang this
 * line exists to prevent: a background agent can still be waiting on one after its turn's `done`.
 */
function declineQueuedApprovals(sessionId: string, entry: SessionEntry, reason: string): void {
  const queued = entry.queuedApprovals ?? [];
  entry.queuedApprovals = undefined;
  for (const ev of queued) {
    chatService.resolveApproval(entry.providerId, sessionId, ev.requestId, false, undefined, { reason, origin: "ws" });
    broadcast(sessionId, { type: "approval_resolved", requestId: ev.requestId, approved: false, answers: null });
  }
}

/**
 * Forward an event to connected WS clients for a session (if any).
 * Used by background processes (e.g. Jira debug) that run sessions server-side
 * but want to stream events to any frontend client viewing that session.
 */
export function forwardEventToSession(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.clients.size === 0) return; // no connected clients, silently drop
  bufferAndBroadcast(sessionId, event);
}

/** Broadcast event to all connected clients for a session */
function broadcast(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.clients.size === 0) {
    const evType = (event as any)?.type ?? "unknown";
    if (evType !== "ping" && evType !== "phase_changed") {
      // The normal state of a turn nobody is watching, at the rate of streamed chunks: counted,
      // and said once when the session goes idle (setPhase).
      if (entry) entry.droppedEvents = (entry.droppedEvents ?? 0) + 1;
      else log.debug(`session=${sessionId} broadcast: no session entry, dropping ${evType}`);
    }
    return;
  }
  const json = JSON.stringify(event);
  for (const client of entry.clients) {
    try { client.send(json); } catch { evictClient(entry, client); }
  }
}

/** Buffer event in turnEvents + broadcast to all clients */
function bufferAndBroadcast(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  const evType = (event as any)?.type;
  const streamed = evType && BUFFERABLE_TYPES.has(evType)
    ? { ...(event as Record<string, unknown>), streamSeq: ++entry.streamSeq }
    : event;
  if (evType && BUFFERABLE_TYPES.has(evType)) {
    if (entry.turnEvents.length < MAX_TURN_EVENTS) {
      entry.turnEvents.push(streamed);
    }
    // Enrich: embed tool_result onto matching tool_use for reconnect reliability.
    // Reconnecting clients may miss separate tool_result events — this ensures
    // the tool_use event itself carries the result as a fallback.
    if (evType === "tool_result") {
      const toolUseId = (event as any)?.toolUseId;
      if (toolUseId) {
        for (let i = entry.turnEvents.length - 1; i >= 0; i--) {
          const buffered = entry.turnEvents[i] as any;
          if (buffered.type === "tool_use" && buffered.toolUseId === toolUseId) {
            buffered.result = { output: (event as any).output, isError: (event as any).isError, exitCode: (event as any).exitCode };
            break;
          }
        }
      }
    }
  }
  broadcast(sessionId, streamed);
}

/**
 * Emit a nested-agent child from the provider or disk. Buffered for reconnect replay only
 * while its turn is still in flight and under the nested budget; a background
 * agent that outlives the turn streams its children unbuffered, since the next
 * turn's replay is not the place for them and reload restores them from disk.
 */
function emitNestedChild(sessionId: string, child: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  const inFlight = entry.isStreamingActive && entry.phase !== "idle";
  if (inFlight && (entry.nestedBuffered ?? 0) < MAX_NESTED_TURN_EVENTS) {
    entry.nestedBuffered = (entry.nestedBuffered ?? 0) + 1;
    bufferAndBroadcast(sessionId, child);
  } else {
    broadcast(sessionId, child);
  }
}

/** How often a session may stat ~/.claude/teams looking for an implicit team. */
const IMPLICIT_TEAM_PROBE_INTERVAL_MS = 3_000;

/** Watch a team's inboxes and announce it to the session's clients. Idempotent. */
async function attachTeamWatcher(sessionId: string, teamName: string): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.teamNames.has(teamName)) return;
  entry.teamNames.add(teamName);
  const { startTeamInboxWatcher } = await import("./team-inbox-watcher.ts");
  const watcher = await startTeamInboxWatcher(teamName, {
    onInboxUpdate: (tn, agent, msgs) => broadcast(sessionId, {
      type: "team_inbox", teamName: tn, agent, messages: msgs,
    }),
    onConfigUpdate: (tn, config) => broadcast(sessionId, {
      type: "team_updated", teamName: tn, team: config,
    }),
  });
  // The session may have been torn down while the watcher was starting.
  const live = activeSessions.get(sessionId);
  if (!live) { watcher.cleanup(); return; }
  live.teamWatchers.set(teamName, watcher);
  bufferAndBroadcast(sessionId, { type: "team_detected", teamName });
  log.info(`session=${sessionId} team detected: ${teamName}`);
}

/** Attach to the team Claude Code creates implicitly for this session.
 *  Current releases no longer expose a TeamCreate tool — a team materialises as
 *  ~/.claude/teams/<sessionId>/inboxes/ with no tool call to hook and no
 *  config.json, so the directory itself is the only reliable signal. */
async function detectImplicitTeam(sessionId: string): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.teamNames.has(sessionId)) return;
  const now = Date.now();
  if (entry.lastImplicitTeamProbe && now - entry.lastImplicitTeamProbe < IMPLICIT_TEAM_PROBE_INTERVAL_MS) return;
  entry.lastImplicitTeamProbe = now;
  try {
    const { teamExists } = await import("./team-inbox-watcher.ts");
    if (await teamExists(sessionId)) await attachTeamWatcher(sessionId, sessionId);
  } catch { /* teams dir unreadable — nothing to attach */ }
}

/** Transition session phase — guards same-phase, broadcasts phase_changed */
/**
 * Rewrite a typed `/skill` to the sigil the session's provider recognises, in
 * place on the parsed message.
 *
 * Only providers that own a skill runtime (`listSkills`) are affected, so a
 * Claude session is left alone entirely. PPM's own built-ins are checked first
 * and never rewritten: `/clear` and `/version` are handled by PPM regardless of
 * which provider the tab is on, and must keep their slash to be intercepted.
 */
async function rewriteProviderSkillSigil(
  parsed: { content: string },
  providerId: string,
  sessionId: string,
): Promise<void> {
  const content = parsed.content.trimStart();
  if (!content.startsWith("/")) return;
  if (providerId === "antigravity") return;
  const provider = providerRegistry.get(providerId);
  if (!provider?.listSkills) return;

  const { isPpmHandled } = await import("../../services/slash-discovery/index.ts");
  const name = content.match(/^\/(\S+)/)?.[1];
  if (!name || isPpmHandled(name)) return;

  try {
    const { applySkillSigil } = await import("../../services/slash-discovery/provider-skill-sigil.ts");
    const skills = await provider.listSkills(sessionId);
    const rewritten = applySkillSigil(content, new Set(skills.map((s) => s.name)), "$");
    if (rewritten !== content) parsed.content = rewritten;
  } catch (e) {
    // Listing failed (app-server down, account not logged in). Send what the
    // user typed rather than dropping their message.
    log.warn(`session=${sessionId} provider=${providerId} skill list failed, sent unrewritten: ${(e as Error).message}`);
  }
}

function setPhase(sessionId: string, phase: SessionPhase, elapsed?: number): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.phase === phase) return;
  entry.phase = phase;
  broadcast(sessionId, { type: "phase_changed", phase, ...(elapsed != null ? { elapsed } : {}) });
  // Also announce app-wide: the tab strip and title indicator must reflect a
  // running session whose chat tab is not mounted, and — more importantly — must
  // stop indicating once it goes idle. Volume is a handful of events per turn.
  broadcastGlobalEvent({ type: "session:phase_changed", sessionId, phase, projectName: entry.projectName ?? "" });
  const dropped = phase === "idle" ? entry.droppedEvents : undefined;
  if (dropped) entry.droppedEvents = 0;
  log.debug(`session=${sessionId} phase → ${phase}${dropped ? ` (${dropped} events dropped: no clients)` : ""}`);
}

/** Send buffered turn events to a single client (reconnect sync) */
function sendTurnEvents(sessionId: string, ws: ChatWsSocket): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.turnEvents.length === 0) return;
  const lastBufferedSeq = (entry.turnEvents[entry.turnEvents.length - 1] as { streamSeq?: number } | undefined)?.streamSeq ?? 0;
  const truncated = lastBufferedSeq < entry.streamSeq;
  try {
    ws.send(JSON.stringify({
      type: "turn_events",
      events: entry.turnEvents,
      userMessage: entry.currentUserMessage ?? null,
      ...(entry.currentClientMessageId ? { clientMessageId: entry.currentClientMessageId } : {}),
      // This is an authoritative full snapshot, not a delta. `truncated` tells
      // the client it must wait for the normal idle history reload to recover
      // frames beyond the bounded replay buffer.
      streamSeq: entry.streamSeq,
      ...(truncated ? { truncated: true } : {}),
    }));
  } catch (e) {
    log.warn(`session=${sessionId} sendTurnEvents failed: ${(e as Error).message}`);
  }
}

/** Set up per-client application-level ping */
function setupClientPing(entry: SessionEntry, ws: ChatWsSocket): void {
  const interval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping", streamSeq: entry.streamSeq })); } catch { /* ws may be closed */ }
  }, PING_INTERVAL_MS);
  entry.pingIntervals.set(ws, interval);
}

/** Clear per-client ping */
function clearClientPing(entry: SessionEntry, ws: ChatWsSocket): void {
  const interval = entry.pingIntervals.get(ws);
  if (interval) {
    clearInterval(interval);
    entry.pingIntervals.delete(ws);
  }
}

/** Start cleanup timer — only for idle sessions. Active (streaming) sessions are never cleaned up; they run until done. */
export function startCleanupTimer(sessionId: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  // Never clean up a session that is still streaming — it will self-cleanup in the consumer's finally block
  if (entry.isStreamingActive) return;
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = setTimeout(() => {
    // Double-check: don't kill if streaming started while timer was pending
    if (entry.isStreamingActive) return;
    // A pending release means the subprocess is still worth holding, and dropping the entry
    // takes it with us. Come back after that timer rather than stretching this one.
    if (entry.cacheReleaseTimer) {
      entry.cleanupTimer = undefined;
      startCleanupTimer(sessionId);
      return;
    }
    log.info(`session=${sessionId} cleanup: idle with no FE for ${CLEANUP_TIMEOUT_MS / 1000}s`);
    // Backstop for the subprocess: scheduleSubprocessRelease normally gets there first,
    // timed off the last turn rather than off this disconnect. It bails when a turn was in
    // flight, so the session entry going away is the last chance to free the process.
    const provider = providerRegistry.get(entry.providerId);
    if (provider?.hasStreamingSession?.(sessionId)) {
      chatService.abortQuery(entry.providerId, sessionId, "idle_timeout", "ws");
    }
    if (entry.cacheReleaseTimer) {
      clearTimeout(entry.cacheReleaseTimer);
      entry.cacheReleaseTimer = undefined;
    }
    for (const interval of entry.pingIntervals.values()) clearInterval(interval);
    entry.pingIntervals.clear();
    for (const w of entry.teamWatchers.values()) w.cleanup();
    entry.teamWatchers.clear();
    backgroundShellRegistry.clearSession(sessionId);
    activeSessions.delete(sessionId);
  }, CLEANUP_TIMEOUT_MS);
}

/** Which turn a sent message opened (`turn_started`). */
export interface TurnBinding {
  turnId: string;
  clientMessageId?: string;
}

/** How many `turn_started` bindings a session keeps for late joiners. */
const MAX_TURN_BINDINGS = 50;

function rememberTurnBinding(entry: SessionEntry, ev: { turnId?: unknown; clientMessageId?: unknown }): void {
  if (typeof ev.turnId !== "string") return;
  const binding: TurnBinding = { turnId: ev.turnId, ...(typeof ev.clientMessageId === "string" ? { clientMessageId: ev.clientMessageId } : {}) };
  const list = (entry.turnBindings ??= []);
  list.push(binding);
  if (list.length > MAX_TURN_BINDINGS) list.splice(0, list.length - MAX_TURN_BINDINGS);
  for (const listener of turnBindingListeners) {
    try { listener(binding); } catch (e) { log.warn(`turn binding listener failed: ${(e as Error).message}`); }
  }
}

const turnBindingListeners = new Set<(binding: TurnBinding) => void>();

/** Hears every `turn_started` a session's consumer sees, with the client id it was sent under. */
export function onTurnBinding(listener: (binding: TurnBinding) => void): () => void {
  turnBindingListeners.add(listener);
  return () => { turnBindingListeners.delete(listener); };
}

/** A turn is in flight through any door: a running provider run, or a socket that is not idle. */
setTurnRunningProbe((sessionId) => chatService.turnActivity(sessionId).running
  || (activeSessions.get(sessionId)?.phase ?? "idle") !== "idle");

/**
 * A turn the provider asked for (`provider_continue`), sent the way another session's message is:
 * every device draws it once the provider has it, and it never answers a pending approval.
 */
async function continueFromProvider(sessionId: string, content: string): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.phase !== "idle" || !content) return;
  const result = await withSessionLock(sessionId, async () => entry.phase !== "idle" ? null
    : submitToSession(sessionId, entry, content, {
      origin: "provider",
      priority: "next",
      receivedAt: Date.now(),
      supersedePendingApproval: false,
      echoOnHandOff: true,
    }));
  if (result && !result.ok) log.error(`session=${sessionId} provider continuation failed: ${result.error}`);
}

/**
 * Persistent event consumer — runs for the entire session lifetime.
 * First message creates the query; follow-ups push into the provider's
 * message channel. Events from ALL turns flow through this single loop.
 */
async function startSessionConsumer(sessionId: string, providerId: string, content: string, permissionMode?: string, images?: Array<{ data: string; mediaType: string }>, model?: string, imagePaths?: string[], clientMessageId?: string, origin: TraceOrigin = "ws"): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    log.error(`session=${sessionId} startSessionConsumer: no entry — aborting`);
    return;
  }
  log.debug(`session=${sessionId} startSessionConsumer started (clients=${entry.clients.size})`);

  entry.isStreamingActive = true;
  clearPendingApproval(sessionId, entry, DB_APPROVAL_TURN_OVER);
  entry.turnEvents = [];
  entry.nestedBuffered = 0;
  entry.finalText = undefined;
  setPhase(sessionId, "connecting");

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastContextWindowPct: number | undefined;

  try {
    log.debug(`session=${sessionId} sending message to provider=${providerId}`);

    let eventCount = 0;
    let firstEventReceived = false;
    let startTime = Date.now();

    // Heartbeat: while waiting for first response, send elapsed time every 5s
    const CONNECTION_TIMEOUT_S = 120;
    heartbeat = setInterval(() => {
      if (firstEventReceived) {
        clearInterval(heartbeat);
        return;
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed >= CONNECTION_TIMEOUT_S) {
        clearInterval(heartbeat);
        log.error(`session=${sessionId} SDK connection timeout after ${elapsed}s — subprocess may have failed to start`);
        const projectPath = entry?.projectPath ?? "";
        if (providerId === "claude") {
          const isWSL = projectPath.startsWith("/home/") || projectPath.startsWith("/mnt/");
          const wslHint = isWSL
            ? "\n\nWSL detected — this is likely a network issue. Try from your WSL terminal:\n  curl -s https://api.anthropic.com\nIf that fails, check WSL DNS settings (/etc/resolv.conf) or proxy configuration."
            : "";
          const debugCmd = projectPath ? `cd ${projectPath} && claude -p "hi"` : `claude -p "hi"`;
          bufferAndBroadcast(sessionId, {
            type: "error",
            message: `Claude SDK timed out after ${elapsed}s for project "${projectPath || "(no project)"}".${wslHint}\n\nDebug steps:\n1. Run: \`${debugCmd}\` — if it also hangs, the issue is your Claude CLI environment\n2. Check env vars: \`echo $ANTHROPIC_API_KEY $ANTHROPIC_BASE_URL\` — stale/invalid keys cause silent hang\n3. Try with env cleared: \`ANTHROPIC_API_KEY="" ANTHROPIC_BASE_URL="" ${debugCmd}\`\n4. Check hooks/MCP: \`cat ${projectPath}/.claude/settings.local.json\`\n5. Refresh auth: \`claude login\``,
          });
        } else {
          bufferAndBroadcast(sessionId, {
            type: "error",
            message: `Provider "${providerId}" timed out after ${elapsed}s for project "${projectPath || "(no project)"}" — the subprocess may have failed to start. Check that the provider's CLI is installed and authenticated, then retry.`,
          });
        }
        return;
      }
      broadcast(sessionId, { type: "phase_changed", phase: "connecting", elapsed });
    }, 5_000);

    // Per-session effort/thinking overrides (sticky, read fresh each turn). Null = inherit
    // provider config: omit so the provider falls back. thinking 0 = explicit OFF (overrides config).
    const effortOverride = getSessionEffort(sessionId) ?? undefined;
    const thinkingBudget = getSessionThinking(sessionId);
    for await (const event of chatService.sendMessage(providerId, sessionId, content, { permissionMode, images, ...(imagePaths?.length && { imagePaths }), ...(model && { model }), ...(effortOverride && { effort: effortOverride }), ...(thinkingBudget != null && { thinkingBudget }), ...(clientMessageId && { clientMessageId }), origin })) {
      eventCount++;
      const ev = event as any;
      const evType = ev.type ?? "unknown";

      // Child streams can outlive the root turn. Their content and terminal
      // events belong to the Agent card, never to the root turn's lifecycle.
      if (ev.parentToolUseId) {
        emitNestedChild(sessionId, event);
        continue;
      }
      // Codex's synthetic Agent card result has no parentToolUseId. A late
      // completion still updates connected cards, but cannot start a root turn
      // or create replay that would replace the completed assistant history.
      if (evType === "tool_result" && ev.toolUseId?.startsWith("subagent-") && entry.phase === "idle") {
        broadcast(sessionId, event);
        continue;
      }
      // A provider asking for a turn of its own: a follow-up like one the user sends, shown as
      // their message. Ignored while a turn runs, which reaches the provider anyway.
      if (evType === "provider_continue") {
        if (entry.phase === "idle") void continueFromProvider(sessionId, String(ev.content ?? ""));
        continue;
      }
      // The provider's own queue reporting on a message PPM queued with it.
      if (evType === "queue_lifecycle") {
        const started = applyQueueLifecycle(entry, ev.id, ev.state, { broadcast: (e) => broadcast(sessionId, e) });
        if (started) queuedMessageStarted(sessionId, entry, started);
        continue;
      }

      // System events → transition connecting → thinking, forward compact events
      if (evType === "system") {
        const sub = (ev as any).subtype;
        if (sub === "init") {
          if (Array.isArray(ev.mcpServers)) {
            entry.mcpNeedsAuth = needsAuthServerNames(ev.mcpServers);
            broadcast(sessionId, mcpStatusEvent(entry.mcpNeedsAuth));
          }
          // Not awaited: the turn goes on while the CLI answers.
          void refreshEffortStatus({
            sessionId,
            session: entry,
            provider: providerRegistry.get(entry.providerId),
            isCurrent: () => activeSessions.get(sessionId) === entry,
            broadcast: (event) => broadcast(sessionId, event),
            log: (line) => log.info(`session=${sessionId} ${line}`),
          });
        } else if (sub === "compacting") {
          entry.compactStatus = "compacting";
          log.debug(`session=${sessionId} compact_status=compacting (persisted on entry)`);
          broadcast(sessionId, { type: "compact_status", status: "compacting" });
        } else if (sub === "compact_done") {
          entry.compactStatus = null;
          log.debug(`session=${sessionId} compact_status=done (via compact_boundary)`);
          broadcast(sessionId, { type: "compact_status", status: "done" });
        } else if (sub === "task_started" || sub === "task_updated" || sub === "task_notification") {
          // Background command (local_bash) lifecycle. shellId === SDK task_id.
          const taskId = (ev as any).taskId as string | undefined;
          const taskStatus = (ev as any).taskStatus as string | undefined;
          const taskToolUseId = (ev as any).taskToolUseId as string | undefined;
          const outputFile = (ev as any).outputFile as string | undefined;
          // A backgrounded Agent reports its outcome only here — its tool_result was a
          // launch ack the card must not read as "finished". Forward the terminal state so
          // the card can settle. Harmless for background bash tasks: no card matches them.
          if (sub === "task_notification" && taskToolUseId && isTerminalAgentStatus(taskStatus)) {
            broadcast(sessionId, { type: "subagent_status", toolUseId: taskToolUseId, status: taskStatus });
            // The agent is done, so its nested workers are too — release the tail.
            nestedSubagentSpy.stopSpy(taskToolUseId);
            entry.backgroundToolUseIds?.delete(taskToolUseId);
          }
          if (taskId) {
            // Ensure the shell is registered even if the spy missed the file (fallback).
            if (!backgroundShellRegistry.get(sessionId, taskId) && outputFile) {
              backgroundShellRegistry.register(sessionId, {
                shellId: taskId,
                command: backgroundShellRegistry.get(sessionId, taskId)?.command ?? "",
                outputPath: outputFile,
                toolUseId: taskToolUseId ?? "",
              });
            }
            const done = taskStatus === "completed" || taskStatus === "failed" || taskStatus === "stopped" || taskStatus === "killed";
            if (done && backgroundShellRegistry.setStatus(sessionId, taskId, "stopped")) {
              const sh = backgroundShellRegistry.get(sessionId, taskId);
              if (sh?.toolUseId) { bashOutputSpy.stopSpy(sh.toolUseId); entry.backgroundToolUseIds?.delete(sh.toolUseId); }
              bgShellLog.info(`session=${sessionId} task ${taskId} -> stopped (${taskStatus})`);
              broadcastBackgroundRegistry(sessionId);
            } else {
              broadcastBackgroundRegistry(sessionId);
            }
          }
        }
        // Promote connecting → thinking only while a turn is actually in flight.
        // The provider subprocess outlives a turn and keeps emitting system events
        // between turns (`commands_changed` when skills/commands change on disk,
        // status pings, ...). Every turn leaves `idle` before its first event
        // arrives, so an idle phase here means no turn is running — promoting it
        // would strand the session non-idle forever: no `done` follows to reset it,
        // and the FE spinner (tab strip + `/sessions/running` seed) never clears.
        if (!firstEventReceived && entry.phase !== "idle") {
          if (heartbeat) clearInterval(heartbeat);
          setPhase(sessionId, "thinking");
        }
        continue;
      }

      // First content event — stop heartbeat, transition phase
      // status_update is PPM's pre-flight account selection — not actual SDK content
      // `turn_started` arrives before the model has said anything: the turn has an id, not content.
      const isMetadataEvent = evType === "account_info" || evType === "account_retry" || evType === "streaming_status" || evType === "status_update" || evType === "turn_started" || evType === "session_migrated";
      if (!firstEventReceived && !isMetadataEvent) {
        firstEventReceived = true;
        const requested = entry.turnRequestedAt;
        entry.turnRequestedAt = undefined;
        // A turn nobody sent over this socket (scheduler, remote trigger) has no receipt time.
        const waitMs = Date.now() - (requested?.at ?? startTime);
        const path = requested ? (requested.cold ? "cold" : "warm") : "unsent";
        log.info(`session=${sessionId} first SDK event after ${waitMs}ms: type=${evType} path=${path}`);
        if (heartbeat) clearInterval(heartbeat);
        const newPhase = evType === "thinking" ? "thinking" : "streaming";
        setPhase(sessionId, newPhase);
      }

      // Dynamic phase transitions between thinking/streaming
      if (firstEventReceived) {
        if (evType === "text" && entry.phase === "thinking") setPhase(sessionId, "streaming");
        if (evType === "thinking" && entry.phase === "streaming") setPhase(sessionId, "thinking");
      }

      // A top-level tool call starts a new block, so only the text after the last one is the answer.
      if (!ev.parentToolUseId) {
        if (evType === "text" && typeof ev.content === "string") {
          const text: string = (entry.finalText ?? "") + ev.content;
          entry.finalText = text.length > FINAL_TEXT_KEEP ? text.slice(0, FINAL_TEXT_KEEP) : text;
        } else if (evType === "tool_use") {
          entry.finalText = undefined;
        }
      }

      if (evType === "tool_use") {
        // Track TeamCreate calls for team detection
        if (ev.tool === "TeamCreate") {
          entry.pendingTeamCreate = ev.toolUseId;
          log.info(`session=${sessionId} TeamCreate tool_use detected, toolUseId=${ev.toolUseId}`);
        }
        // A session-level Agent card: the SDK streams its agent's own steps, but
        // nothing from agents that agent spawns in turn. Tail those nested
        // transcripts from disk so the card keeps moving instead of freezing on
        // the step that forked them. Claude-SDK-only — the layout is the CLI's.
        if (providerId === "claude" && (ev.tool === "Agent" || ev.tool === "Task") && ev.toolUseId && !ev.parentToolUseId) {
          const sessionDir = resolveSessionDir(sessionId, entry.projectPath);
          if (sessionDir) {
            nestedSubagentSpy.startSpy(sessionId, ev.toolUseId, sessionDir, (events) => {
              for (const child of events) emitNestedChild(sessionId, child);
            });
          }
        }
        // Start output spy for real-time streaming (Bash on Linux/macOS, PowerShell on Windows).
        // Claude-SDK-only: it tails the SDK's per-tool output file. Other providers
        // (codex/cursor) run commands in their own subprocess with no such file.
        if (providerId === "claude" && (ev.tool === "Bash" || ev.tool === "PowerShell") && ev.toolUseId) {
          const command = typeof ev.input === "object" && ev.input
            ? String((ev.input as any).command ?? "")
            : "";
          const isBackground = typeof ev.input === "object" && ev.input
            ? (ev.input as any).run_in_background === true
            : false;
          const toolUseId = ev.toolUseId;
          if (command) {
            if (isBackground) {
              (entry.backgroundToolUseIds ??= new Set()).add(toolUseId);
              bgShellLog.debug(`session=${sessionId} background command started toolUseId=${toolUseId}`);
            }
            bashOutputSpy.startSpy(toolUseId, command, sessionId, (output) => {
              broadcast(sessionId, {
                type: "bash_output",
                toolUseId: output.toolUseId,
                content: output.newContent,
                lineCount: output.totalLineCount,
              });
            }, entry.projectPath ?? "", isBackground ? (filePath) => {
              // Resolved .output path → register the background shell (shellId = basename w/o ext)
              const shellId = basename(filePath).replace(/\.output$/, "");
              backgroundShellRegistry.register(sessionId, { shellId, command, outputPath: filePath, toolUseId });
              bgShellLog.info(`session=${sessionId} registered shellId=${shellId} clients=${activeSessions.get(sessionId)?.clients.size ?? 0} file=${filePath}`);
              broadcastBackgroundRegistry(sessionId);
            } : undefined);
          }
        }
        // Background command stopped via SDK KillShell — flip status to stopped
        if (providerId === "claude" && ev.tool === "KillShell") {
          const sid = typeof ev.input === "object" && ev.input
            ? String((ev.input as any).task_id ?? (ev.input as any).shell_id ?? (ev.input as any).shellId ?? "")
            : "";
          if (sid) {
            const killed = backgroundShellRegistry.get(sessionId, sid);
            if (backgroundShellRegistry.setStatus(sessionId, sid, "stopped")) {
              if (killed?.toolUseId) {
                bashOutputSpy.stopSpy(killed.toolUseId);
                entry.backgroundToolUseIds?.delete(killed.toolUseId);
              }
              broadcastBackgroundRegistry(sessionId);
            }
          }
        }
      } else if (evType === "tool_result") {
        log.debug(`session=${sessionId} tool_result toolUseId=${ev.toolUseId} isError=${ev.isError ?? false} chars=${typeof ev.output === "string" ? ev.output.length : 0}`);
        // A backgrounded Agent's tool_result is only a launch ack while the agent
        // runs on — keep its nested spy until the terminal task_notification.
        // Keyed off the ack text: `input.run_in_background` is optional and absent
        // from most recorded calls (see background-agent-status.ts).
        if (ev.toolUseId && !ev.parentToolUseId && isAsyncAgentLaunchAck(ev.output)) {
          (entry.backgroundToolUseIds ??= new Set()).add(ev.toolUseId);
        }
        // Stop bash output spy for this tool — EXCEPT background commands, whose
        // process keeps running after tool_result; keep tailing their .output.
        if (ev.toolUseId && !entry.backgroundToolUseIds?.has(ev.toolUseId)) {
          bashOutputSpy.stopSpy(ev.toolUseId);
          nestedSubagentSpy.stopSpy(ev.toolUseId);
        }
        // Detect team creation from TeamCreate tool_result (legacy explicit teams)
        if (entry.pendingTeamCreate && entry.pendingTeamCreate === ev.toolUseId) {
          const { extractTeamName } = await import("./team-inbox-watcher.ts");
          const teamName = extractTeamName(ev.output ?? "");
          log.info(`session=${sessionId} TeamCreate result matched, extracted teamName=${teamName}`);
          if (teamName) await attachTeamWatcher(sessionId, teamName);
          entry.pendingTeamCreate = undefined;
        }
        // Implicit teams have no tool result to key off — the session's own team
        // directory can appear after any Agent/SendMessage call, so poll (throttled).
        void detectImplicitTeam(sessionId);
      } else if (evType === "error") {
        const errorDetail = ev.message ?? JSON.stringify(ev).slice(0, 500);
        log.error(`session=${sessionId} error: ${errorDetail}`);
      } else if (evType === "done") {
        // Turn complete — transition to idle, clear buffer for next turn
        if (ev.contextWindowPct != null) lastContextWindowPct = ev.contextWindowPct;
        // The prompt cache was just written, which is what the retention window is measured
        // from. A turn can complete with nobody watching (remote trigger, scheduler), and the
        // release pending from the disconnect was timed against the previous turn — re-time it
        // or it fires while the cache it was protecting is still fresh.
        entry.lastTurnEndedAt = Date.now();
        if (ev.usage) entry.lastTurnPrefixTokens = prefixTokens(ev.usage);
        if (ev.usage?.contextTokens != null) entry.lastTurnContextTokens = ev.usage.contextTokens;
        if (ev.usage?.cacheTtlMs != null) entry.lastTurnCacheTtlMs = ev.usage.cacheTtlMs;
        // Assigned rather than only-when-present: the provider clears this the moment an API
        // call re-caches, and that clearing is the signal the cache is usable again. Skipping
        // the undefined case would leave a session cold for the rest of its life.
        if (ev.usage) entry.lastTurnCompactedAt = ev.usage.compactedAt;
        if (entry.clients.size === 0) scheduleSubprocessRelease(sessionId);

        // Fire-and-forget: fetch updated session title (DB title takes priority) + notification
        if (entry.providerId === "antigravity") {
          const title = resolveDisplaySessionTitle(sessionId, entry.providerId, chatService.getSession(sessionId)?.title);
          if (title) {
            broadcast(sessionId, { type: "title_updated", title });
            const session = chatService.getSession(sessionId);
            if (session) session.title = title;
          }
        } else {
          sdkListSessions({ dir: entry.projectPath, limit: 50 }).then((sessions) => {
            const found = sessions.find((s) => s.sessionId === sessionId || s.sessionId === ev.sessionId);
            const dbTitle = getSessionTitle(found?.sessionId ?? sessionId);
            const title = dbTitle ?? found?.customTitle ?? found?.summary;
            if (title) {
              broadcast(sessionId, { type: "title_updated", title });
              const session = chatService.getSession(sessionId);
              if (session) session.title = title;
            }
          }).catch(() => {});
        }
        // Persist unread to DB + broadcast to all tabs/devices
        const doneSession = chatService.getSession(sessionId);
        const doneTitle = resolveDisplaySessionTitle(sessionId, entry.providerId, doneSession?.title) ?? undefined;
        // The project comes from the connection, not from a separate write on open: a
        // session PPM did not create has no metadata row until this runs, and this is the
        // one place that knows both the session and its project.
        incrementSessionUnread(sessionId, "done", doneTitle, entry.projectName || null);
        broadcastGlobalEvent({ type: "session:unread_changed", sessionId, unreadCount: -1, unreadType: "done", projectName: entry.projectName || "", sessionTitle: doneTitle || null });

        // The trace already holds this `done`: ChatService records an event before yielding it.
        // Sent ahead of the `done` itself, so the bar is there the moment the turn goes idle.
        const turnStop = lastTurnStop(sessionId);
        if (turnStop) broadcast(sessionId, { type: "turn_stop", stop: turnStop });
        const stopped = turnStop ? describeTurnStop(turnStop) : null;

        const finalText = entry.finalText;
        // The consumer outlives the turn (Claude pushes a follow-up into the same stream), so
        // the next turn's answer must not start with this one's.
        entry.finalText = undefined;
        if (finalText) entry.lastAnswer = finalText;
        // An AI-created session finishing is its creator's business, not the user's: no "Chat
        // completed". A turn stopped by an error still says so.
        if (!stopped && isSpawned(sessionId)) {
          log.debug(`session=${sessionId} turn done: no notification for an AI-created session`);
        } else import("../../services/notification.service.ts").then(({ notificationService }) => {
          const project = entry.projectName || "Project";
          const session = chatService.getSession(sessionId);
          const sessionTitle = session?.title || `Session ${sessionId.slice(0, 8)}`;
          notificationService.broadcast("done", {
            title: stopped ? "Chat stopped" : "Chat completed",
            body: `${project} — ${sessionTitle}`,
            project: entry.projectName || "",
            sessionId,
            providerId: entry.providerId,
            sessionTitle,
            detail: stopped ? [stopped.title, stopped.detail].filter(Boolean).join("\n") : finalText,
            detailStyle: "quote",
          }, {
            // Any browser showing the session clears its unread mark at once.
            stillUnseen: () => getSessionUnreadCount(sessionId) > 0,
          });
        }).catch(() => {});
      } else if (evType === "approval_request") {
        // Sent by `receiveApprovalRequest` — now, or once the request before it is answered.
        receiveApprovalRequest(sessionId, entry, ev);
        continue;
      } else if (evType === "turn_started") {
        rememberTurnBinding(entry, ev);
      } else if (evType === "session_migrated") {
        // CLI providers discover real session ID from CLI output — migrate WS tracking
        const newId = ev.newSessionId as string;
        if (newId && newId !== sessionId) {
          log.info(`session_migrated: ${sessionId} → ${newId}`);
          // Persist the link before re-keying. A tab that opened under the old
          // id keeps it in its own storage, so without this the conversation
          // becomes unreachable from that tab the moment the turn ends.
          setSessionMigratedTo(sessionId, newId);
          pairCounter.renameSession(sessionId, newId);
          collabSessionRenamed(sessionId, newId);
          // Stop spies tagged with old session ID before re-keying
          bashOutputSpy.stopAllForSession(sessionId);
          nestedSubagentSpy.stopAllForSession(sessionId);
          backgroundShellRegistry.clearSession(sessionId);
          const oldEntry = activeSessions.get(sessionId);
          if (oldEntry) {
            activeSessions.delete(sessionId);
            activeSessions.set(newId, oldEntry);
            // Re-point each live socket's session key so follow-up messages over
            // the same connection resolve to the moved entry (not auto-create a stale one).
            for (const client of oldEntry.clients) {
              try { (client as any).data.sessionId = newId; } catch { /* ignore */ }
            }
          }
          // Announce the rename app-wide too. Every later phase change goes out under the
          // new id, so a client that only hears the global bus — which is every client whose
          // chat tab is not mounted — would keep the old id marked running for good: its
          // `idle` is never coming, because nothing is keyed to it any more.
          broadcastGlobalEvent({
            type: "session:migrated",
            oldSessionId: sessionId,
            newSessionId: newId,
            projectName: oldEntry?.projectName ?? "",
          });
          if (oldEntry && oldEntry.phase !== "idle") {
            broadcastGlobalEvent({
              type: "session:phase_changed",
              sessionId: newId,
              phase: oldEntry.phase,
              projectName: oldEntry.projectName ?? "",
            });
          }
          // The consumer must target the new id for every subsequent broadcast —
          // including this session_migrated event — since the entry moved. Without
          // this, a provider that always migrates (e.g. codex: threadId ≠ ppm id)
          // would have all its stream events dropped.
          sessionId = newId;
        }
      }

      // Buffer + broadcast content events
      bufferAndBroadcast(sessionId, event);

      // After "done", transition to idle + clear turn buffer for next turn
      // Consumer loop continues — query waits for next message in generator
      if (evType === "done") {
        entry.turnEvents = [];
        entry.nestedBuffered = 0;
        clearPendingApproval(sessionId, entry, DB_APPROVAL_TURN_OVER);
        // Clear stale compact status if turn ended without compact_boundary.
        // SDK may emit `status: compacting` without a matching boundary (deferred,
        // resolved, or errored); without this clear, UI shows stuck "Compacting…".
        if (entry.compactStatus === "compacting") {
          entry.compactStatus = null;
          log.debug(`session=${sessionId} compact_status=done (cleared on turn done without boundary)`);
          broadcast(sessionId, { type: "compact_status", status: "done" });
        }
        setPhase(sessionId, "idle");
        // Waits on this session are judged, and a created session stops counting as starting.
        collabTurnEnded(sessionId);
        // What PPM held for this turn goes out now; a provider's own queue starts by itself.
        dispatchQueued(sessionId, entry, false);
        // A renewal that landed while this turn ran left its subprocess holding a revoked
        // token; restart it now rather than let the next message open with a 401. Deferred so
        // the drop does not close the query from inside the loop that is reading it.
        setTimeout(() => dropStaleIdle(tokenRotationDeps), 0);
        // A session no browser has joined is idle now, which is when its subprocess becomes
        // releasable (`idleBetweenTurns`); re-timed here because the release scheduled at `done`
        // ran while the turn was still in flight. Deferred for the same reason as above.
        if (entry.socketless && entry.clients.size === 0) {
          setTimeout(() => {
            if (activeSessions.get(sessionId) !== entry || entry.clients.size > 0) return;
            scheduleSubprocessRelease(sessionId);
            enforceWarmIdleCap();
          }, 0);
        }
        // Reset heartbeat tracking for next turn
        firstEventReceived = false;
        startTime = Date.now();
      }
    }

    log.info(`session=${sessionId} session consumer completed (${eventCount} events)`);
  } catch (e) {
    const errMsg = (e as Error).message;
    log.error(`session=${sessionId} provider=${providerId} consumer failed:`, e);
    bufferAndBroadcast(sessionId, { type: "error", message: errMsg });
    // ChatService wrote `run_failed` and flushed the trace before the throw reached here.
    const turnStop = lastTurnStop(sessionId);
    if (turnStop) broadcast(sessionId, { type: "turn_stop", stop: turnStop });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Drain nested-agent tails while their turn buffer still exists, so the last
    // records land in this turn's replay instead of the head of the next one.
    nestedSubagentSpy.stopAllForSession(sessionId);
    entry.isStreamingActive = false;
    entry.turnEvents = [];
    // Force-clear compact status on stream teardown (error, close, etc.)
    if (entry.compactStatus === "compacting") {
      entry.compactStatus = null;
      log.debug(`session=${sessionId} compact_status=done (cleared on stream teardown)`);
      broadcast(sessionId, { type: "compact_status", status: "done" });
    }
    setPhase(sessionId, "idle");
    clearPendingApproval(sessionId, entry, DB_APPROVAL_TURN_OVER);
    collabTurnEnded(sessionId);
    // Cleanup bash output spies
    bashOutputSpy.stopAllForSession(sessionId);
    // SDK subprocess teardown kills its background children — reflect as stopped
    backgroundShellRegistry.markAllStopped(sessionId);
    broadcastBackgroundRegistry(sessionId);
    // Cleanup team watchers
    for (const w of entry.teamWatchers.values()) w.cleanup();
    entry.teamWatchers.clear();
    // Close streaming session in provider
    const provider = providerRegistry.get(entry.providerId);
    if (provider && "closeStreamingSession" in provider) {
      (provider as any).closeStreamingSession(sessionId);
    }
    // Whatever was still queued went with the process; it is sent now as a turn of its own.
    dispatchQueued(sessionId, entry, true);
    if (entry.clients.size === 0) {
      startCleanupTimer(sessionId);
    }
    log.info(`session=${sessionId} consumer loop ended`);
  }
}

/**
 * A fresh registry entry for a session, with `client` attached, or socketless without one. A
 * session with a stored permission mode (a created session inherits its creator's) starts in it:
 * an entry is made again after cleanup or a restart, and without the stored mode the next turn
 * would fall back to the provider's default, which is usually the most permissive one.
 */
function createSessionEntry(sessionId: string, providerId: string, projectPath: string | undefined, projectName: string | undefined, client?: ChatWsSocket): SessionEntry {
  const storedMode = getStoredPermissionModeAnyAlias(sessionId);
  const entry: SessionEntry = {
    providerId,
    clients: new Set(client ? [client] : []),
    projectPath,
    projectName,
    pingIntervals: new Map(),
    phase: "idle",
    turnEvents: [],
    isStreamingActive: false,
    streamSeq: 0,
    teamWatchers: new Map(),
    teamNames: new Set(),
    compactStatus: null,
    model: getSessionModel(sessionId) ?? undefined,
    ...(storedMode ? { permissionMode: storedMode } : {}),
    ...(client ? {} : { socketless: true, idleSince: Date.now() }),
  };
  activeSessions.set(sessionId, entry);
  if (client) setupClientPing(entry, client);
  return entry;
}

/** A browser joined the session: from now on it is cleaned up as any browser-held session. */
function attachClient(entry: SessionEntry, ws: ChatWsSocket): void {
  entry.clients.add(ws);
  entry.socketless = undefined;
}

/**
 * The session's registry entry, created without a socket when there is none — the same entry a
 * browser connection creates, so a browser that connects later finds the live turn, its replay
 * and its phase exactly as if it had sent the message itself.
 */
export function ensureSessionEntry(sessionId: string, providerId: string, projectPath?: string, projectName?: string): SessionEntry {
  const existing = activeSessions.get(sessionId);
  if (existing) {
    if (projectPath && !existing.projectPath) existing.projectPath = projectPath;
    if (projectName && !existing.projectName) existing.projectName = projectName;
    return existing;
  }
  const entry = createSessionEntry(sessionId, providerId, projectPath, projectName);
  void detectImplicitTeam(sessionId);
  return entry;
}

/** One submission at a time per session, browser and server alike (see `withSessionLock`). */
const sessionLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` once every earlier submission to the same session has finished. Without it a browser
 * message and a message from another session arriving together could both see no consumer
 * running and start two runs of one session.
 */
export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  sessionLocks.set(sessionId, tail);
  void tail.then(() => { if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId); });
  return run;
}

/** Sends the message to every connected device but `except`, as the `user_message` echo. */
export function echoUserMessage(entry: SessionEntry, content: string, opts: { except?: ChatWsSocket; clientMessageId?: string; imageCount: number }): void {
  const echo = JSON.stringify({
    type: "user_message",
    content,
    // Lets the other device tie this message to the `turn_started` it opens, too.
    ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    imageCount: opts.imageCount,
    timestamp: new Date().toISOString(),
  });
  for (const client of [...entry.clients]) {
    if (client === opts.except) continue;
    try { client.send(echo); } catch { evictClient(entry, client); }
  }
}

export interface SubmitToSessionOpts {
  /**
   * `ws` for a browser send, `session` for one from another session's AI, or the door an
   * in-process caller of the chat socket named (`scheduler` for a script schedule).
   */
  origin: TraceOrigin;
  clientMessageId?: string;
  images?: Array<{ data: string; mediaType: string }>;
  imagePaths?: string[];
  priority?: "now" | "next" | "later";
  /** The socket that sent it; none for a server-originated message. */
  sender?: ChatWsSocket;
  /** When the message reached the server, for the time-to-first-event log. */
  receivedAt: number;
  /**
   * Whether a pending approval or question is answered "no" by this message. A person typing
   * instead of answering means that; a message from another session must never decide for the
   * person, so it waits behind the approval instead.
   */
  supersedePendingApproval: boolean;
  /**
   * Draw the message on every device showing the session once the provider has it — for a
   * message no device drew itself. Never before: a refused delivery must not leave a bubble.
   */
  echoOnHandOff?: boolean;
  /** The sender drew no bubble for it (it expected the message to queue), so the echo reaches it too. */
  echoToSender?: boolean;
  /** Queued mid-turn with Ctrl+Enter: the AI reads the queue at once (Claude Code's Send now). */
  sendNow?: boolean;
}

export type SubmitResult = { ok: true; delivered: SessionDelivery } | { ok: false; error: string };

/**
 * What a follow-up handed to the live stream right now will do. Codex says for itself whether
 * it can steer; for Claude a turn waiting on the user or compacting reads its input stream only
 * once that is over.
 */
function followUpDelivery(sessionId: string, entry: SessionEntry): SessionDelivery {
  const provider = providerRegistry.get(entry.providerId) as { followUpDisposition?: (id: string) => SessionDelivery | null } | undefined;
  const told = provider?.followUpDisposition?.(sessionId);
  if (told) return told;
  if (entry.phase === "idle") return "started";
  if (entry.pendingApprovalEvent || entry.compactStatus === "compacting") return "queued";
  return "inserted";
}

/** How long a server-originated message waits for a starting or ending consumer to settle. */
const LIVE_STREAM_WAIT_MS = 30_000;
const LIVE_STREAM_POLL_MS = 25;

/**
 * Waits until the session either has no consumer or has one whose provider stream is live — the
 * two states in which a message is never dropped. False when neither came within the bound.
 */
async function awaitLiveStreamOrNone(sessionId: string, entry: SessionEntry): Promise<boolean> {
  const deadline = Date.now() + LIVE_STREAM_WAIT_MS;
  for (;;) {
    if (!entry.isStreamingActive) return true;
    const provider = providerRegistry.get(entry.providerId);
    // A provider that cannot say keeps the browser path's behaviour: trust the consumer.
    if (!provider?.hasStreamingSession || provider.hasStreamingSession(sessionId)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(LIVE_STREAM_POLL_MS);
  }
}

/**
 * User sent a message instead of answering a pending question/approval.
 * The SDK generator is blocked inside canUseTool awaiting that approval, so
 * it can't consume the pushed message — resolve the approval as skipped to
 * unblock it, then the follow-up message flows through normally.
 */
function declinePendingApproval(sessionId: string, entry: SessionEntry): void {
  if (!entry.pendingApprovalEvent) return;
  const providerId = entry.providerId ?? providerRegistry.getDefault().id;
  const pendingReqId = entry.pendingApprovalEvent.requestId;
  if (ppmApprovals.has(pendingReqId)) {
    // PPM's own approval: settling it takes the card off every device (`ppmApprovalResolved`).
    clearPendingApproval(sessionId, entry, "The user sent a message instead of approving, so nothing ran.");
  } else {
    chatService.resolveApproval(providerId, sessionId, pendingReqId, false, undefined, { reason: "superseded_by_message", origin: "ws" });
    broadcast(sessionId, {
      type: "approval_resolved",
      requestId: pendingReqId,
      approved: false,
      answers: null,
    });
    clearPendingApproval(sessionId, entry, "The user sent a message instead of approving, so nothing ran.");
  }
  log.info(`session=${sessionId} pending approval ${pendingReqId} auto-skipped (user sent a message)`);
}

/**
 * Hands an accepted message to the session: starts the persistent consumer when none is running
 * (resuming the session first), or pushes it into the live stream. The one path a browser message
 * and a server-originated one share; callers hold `withSessionLock`.
 */
export async function submitToSession(sessionId: string, entry: SessionEntry, content: string, opts: SubmitToSessionOpts): Promise<SubmitResult> {
  if (opts.supersedePendingApproval) declinePendingApproval(sessionId, entry);

  // A push the provider has no stream for goes nowhere. That happens while a consumer is still
  // opening its stream, or is on its way out. A server-originated message waits until either the
  // stream is up or the consumer is gone, then pushes or starts.
  if (opts.origin === "session" && !(await awaitLiveStreamOrNone(sessionId, entry))) {
    return { ok: false, error: STILL_STARTING };
  }
  const handed = await handOffToSession(sessionId, entry, content, opts);
  if (handed !== "stream_closed") return handed;
  // The live stream closed between that check and the push (an idle release, the warm-idle cap,
  // a token rotation — none of them waits for this lock), so the message went nowhere. Once the
  // consumer has wound down it opens a turn of its own instead.
  if (!(await awaitLiveStreamOrNone(sessionId, entry))) return { ok: false, error: STILL_STARTING };
  const retried = await handOffToSession(sessionId, entry, content, opts);
  return retried === "stream_closed"
    ? { ok: false, error: "The session closed before it could take the message; try again in a moment" }
    : retried;
}

const STILL_STARTING = "The session is still starting; try again in a moment";

const echoHandedOff = (entry: SessionEntry, content: string, opts: SubmitToSessionOpts): void =>
  echoUserMessage(entry, content, {
    ...(opts.sender && !opts.echoToSender ? { except: opts.sender } : {}),
    ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    imageCount: opts.images?.length ?? 0,
  });

function queueDeps(sessionId: string, entry: SessionEntry): QueueDeps {
  const providerId = entry.providerId ?? providerRegistry.getDefault().id;
  return {
    sessionId,
    provider: providerRegistry.get(providerId),
    broadcast: (event) => broadcast(sessionId, event),
    push: (content, o) => {
      const effort = getSessionEffort(sessionId) ?? undefined;
      const thinkingBudget = getSessionThinking(sessionId);
      return chatService.pushMessage(providerId, sessionId, content, {
        origin: "ws",
        priority: "next",
        ...(o.images ? { images: o.images } : {}),
        ...(o.imagePaths ? { imagePaths: o.imagePaths } : {}),
        ...(o.clientMessageId ? { clientMessageId: o.clientMessageId } : {}),
        ...(o.queueId ? { queueId: o.queueId } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(effort ? { effort } : {}),
        ...(thinkingBudget != null ? { thinkingBudget } : {}),
      });
    },
  };
}

/**
 * The AI started on a queued message: it joins the conversation on every device, the sender's
 * included (nothing was drawn for it when it was sent), and the turn's display starts again here.
 */
function queuedMessageStarted(sessionId: string, entry: SessionEntry, started: Pick<QueuedEntry, "content" | "clientMessageId" | "imageCount">): void {
  entry.currentUserMessage = started.content;
  entry.currentClientMessageId = started.clientMessageId;
  entry.turnEvents = [];
  echoUserMessage(entry, started.content, {
    ...(started.clientMessageId ? { clientMessageId: started.clientMessageId } : {}),
    imageCount: started.imageCount,
  });
  if (entry.phase === "idle") setPhase(sessionId, "thinking");
}

/** Send now: the AI reads the queue at once. Held entries go in as one message, shown now. */
async function sendQueueNow(sessionId: string, entry: SessionEntry): Promise<void> {
  if (!entry.queue?.length) return;
  const sent = await sendQueuedNow(entry, queueDeps(sessionId, entry));
  if (sent.length) queuedMessageStarted(sessionId, entry, { ...mergeEntries(sent), imageCount: sent.reduce((n, e) => n + e.imageCount, 0) });
}

/**
 * What PPM itself must send from the queue goes out as one message: the entries it holds when a
 * turn ends, or every entry once the stream is gone (Stop, a crash), since a provider's own queue
 * went with its process — Claude Code sends what was queued right after an interrupt, too.
 */
function dispatchQueued(sessionId: string, entry: SessionEntry, all: boolean): void {
  const out = drainForDispatch(entry, { broadcast: (event) => broadcast(sessionId, event) }, all);
  if (!out.length) return;
  const merged = mergeEntries(out);
  // Never from inside the consumer that is ending: the message may need a consumer of its own.
  setTimeout(() => {
    if (activeSessions.get(sessionId) !== entry) {
      log.warn(`session=${sessionId} ${out.length} queued message(s) dropped: the session closed`);
      return;
    }
    void withSessionLock(sessionId, () => submitToSession(sessionId, entry, merged.content, {
      origin: "ws",
      ...(merged.clientMessageId ? { clientMessageId: merged.clientMessageId } : {}),
      images: merged.images,
      imagePaths: merged.imagePaths,
      priority: "next",
      receivedAt: Date.now(),
      // Any approval it answered was answered when it was queued.
      supersedePendingApproval: false,
      echoOnHandOff: true,
    })).then((result) => {
      if (!result.ok) {
        log.error(`session=${sessionId} queued message(s) not sent: ${result.error}`);
        broadcast(sessionId, { type: "error", message: `Queued message not sent: ${result.error}` });
      }
    });
  }, 0);
}

/**
 * Starts a turn with the message, or pushes it into the live stream. `stream_closed` when the
 * provider had no stream left to take the push, so the message was not delivered.
 */
async function handOffToSession(sessionId: string, entry: SessionEntry, content: string, opts: SubmitToSessionOpts): Promise<SubmitResult | "stream_closed"> {
  const providerId = entry.providerId ?? providerRegistry.getDefault().id;
  const provider = providerRegistry.get(providerId);

  // A person writing while a turn runs: the message waits in the queue, shown under the
  // conversation, and joins it when the AI starts reading it. Other senders keep going straight in.
  if (opts.origin === "ws" && entry.isStreamingActive && entry.phase !== "idle") {
    const queued = await enqueueMessage(entry, {
      content, images: opts.images, imagePaths: opts.imagePaths, clientMessageId: opts.clientMessageId,
    }, queueDeps(sessionId, entry));
    if (queued === "stream_closed") return "stream_closed";
    log.debug(`session=${sessionId} message queued id=${queued.id} native=${queued.native}`);
    if (opts.sendNow) await sendQueueNow(sessionId, entry);
    return { ok: true, delivered: "queued" };
  }

  // Store user message for reconnect replay (turn_events includes only assistant events)
  entry.currentUserMessage = content;
  entry.currentClientMessageId = opts.clientMessageId;
  entry.lastSender = opts.sender;
  // Only a message that opens a turn is timed; one typed mid-turn joins the running turn.
  if (!entry.isStreamingActive || entry.phase === "idle") {
    entry.turnRequestedAt = { at: opts.receivedAt, cold: !entry.isStreamingActive };
  }

  if (!entry.isStreamingActive) {
    // First message or post-crash recovery: start persistent consumer
    // Resume session in provider (can be slow on first call — sdkListSessions)
    if (provider && "resumeSession" in provider) {
      const t0 = Date.now();
      try {
        await (provider as any).resumeSession(sessionId);
      } catch (e) {
        // The message is dropped, as it was when this rejected out of the handler; this
        // names the session and provider that the socket dispatcher's catch cannot.
        log.error(`session=${sessionId} resume failed provider=${providerId}:`, e);
        return { ok: false, error: `Could not resume the session: ${(e as Error).message}` };
      }
      const elapsed = Date.now() - t0;
      if (elapsed > 500) {
        log.warn(`session=${sessionId} resumeSession took ${elapsed}ms`);
      }
    }
    if (entry.projectPath && provider && "ensureProjectPath" in provider) {
      (provider as any).ensureProjectPath(sessionId, entry.projectPath);
    }
    // Nothing below can refuse the message; the consumer has not started, so no event precedes it.
    if (opts.echoOnHandOff) echoHandedOff(entry, content, opts);

    entry.turnEvents = [];
    setPhase(sessionId, "initializing");

    const permMode = entry.permissionMode;
    const msgModel = entry.model;
    let consumerStarted!: () => void;
    const started = new Promise<void>((resolve) => { consumerStarted = resolve; });
    entry.streamPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        const run = startSessionConsumer(sessionId, providerId, content, permMode, opts.images, msgModel, opts.imagePaths, opts.clientMessageId, opts.origin);
        // The consumer marks itself streaming before its first await: the lock may go now.
        consumerStarted();
        run.then(resolve, resolve);
      }, 0);
    });
    await started;
    return { ok: true, delivered: "started" };
  }

  // Follow-up: push into existing generator via provider
  const delivered = followUpDelivery(sessionId, entry);
  if (provider && "pushMessage" in provider) {
    const effort = getSessionEffort(sessionId) ?? undefined;
    const thinkingBudget = getSessionThinking(sessionId);
    try {
      const pushed = await chatService.pushMessage(providerId, sessionId, content, {
        origin: opts.origin,
        priority: opts.priority ?? "next",
        images: opts.images,
        imagePaths: opts.imagePaths,
        ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(effort ? { effort } : {}),
        ...(thinkingBudget != null ? { thinkingBudget } : {}),
      });
      if (!pushed) return "stream_closed";
      if (opts.echoOnHandOff) echoHandedOff(entry, content, opts);
    } catch (e) {
      log.error(`session=${sessionId} follow-up failed provider=${providerId}:`, e);
      return { ok: false, error: `Could not deliver the message: ${(e as Error).message}` };
    }
  } else if (opts.origin === "session") {
    return { ok: false, error: `Provider "${providerId}" cannot take a message while a turn is running` };
  }
  // Clear turn events for new turn display + transition phase. A superseded approval was settled
  // before the push; one that filled during it is a live request and stays on screen. A message
  // from another session leaves a pending approval where it is: it waits behind it.
  entry.turnEvents = [];
  setPhase(sessionId, "thinking");
  log.debug(`session=${sessionId} follow-up pushed to generator`);
  return { ok: true, delivered };
}

/**
 * Chat WebSocket handler for Bun.serve().
 *
 * Session lifecycle: BE owns Claude connection. FE disconnect does NOT abort Claude.
 * Streaming runs in standalone async function, not tied to WS message handler.
 */
export const chatWebSocket = {
  open(ws: ChatWsSocket) {
    const { sessionId, projectName, providerHint } = ws.data;
    const session = chatService.getSession(sessionId);
    adoptProviderHint(sessionId, providerHint);
    const providerId = resolveStoredProvider(sessionId) ?? providerRegistry.getDefault().id;

    let projectPath: string | undefined;
    if (projectName) {
      try { projectPath = resolveProjectPath(projectName); } catch { reportUnregisteredProject(sessionId, projectName); }
    }
    if (session && !session.projectPath && projectPath) {
      session.projectPath = projectPath;
    }

    const existing = activeSessions.get(sessionId);
    if (existing) {
      // A message that arrived before `open` may have created this entry under a
      // provider guessed before the hint was stored. Nothing has run on it while it is
      // idle, so it can still follow the session's real owner.
      if (existing.phase === "idle" && existing.providerId !== providerId) existing.providerId = providerId;
      // FE reconnecting to existing session — clear cleanup timer
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      // No longer idle: not a candidate for warm-idle eviction, and its subprocess is in
      // use again so the pending cache-expiry release must not fire under it.
      existing.idleSince = undefined;
      if (existing.cacheReleaseTimer) {
        clearTimeout(existing.cacheReleaseTimer);
        existing.cacheReleaseTimer = undefined;
      }
      if (projectPath) existing.projectPath = projectPath;
      if (projectName) existing.projectName = projectName;

      // Send state + turnEvents BEFORE joining clients Set (ordering matters)
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: existing.phase,
        pendingApproval: existing.pendingApprovalEvent ?? null,
        sessionTitle: resolveDisplaySessionTitle(sessionId, existing.providerId, session?.title),
        compactStatus: existing.compactStatus ?? null,
        mcpNeedsAuth: existing.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        effortStatus: resolveEffortStatus(sessionId, existing),
        thinking: resolveSessionThinkingEnabled(sessionId),
        promptCache: promptCacheSnapshot(sessionId, existing),
        turnStop: existing.phase === "idle" ? lastTurnStop(sessionId) : null,
        turnBindings: existing.turnBindings ?? [],
        queue: queueState(existing),
      }));

      // If actively streaming, send buffered turn events for reconnect sync
      if (existing.phase !== "idle") {
        sendTurnEvents(sessionId, ws);
      }

      // NOW add to clients Set + set up ping
      attachClient(existing, ws);
      setupClientPing(existing, ws);

      // A team created in an earlier turn (or before a server restart) leaves no
      // live event to replay — re-attach from disk so the UI comes back.
      void detectImplicitTeam(sessionId);

      // Async: resolve title from SDK if in-memory title is generic (DB title takes priority)
      if (isGenericSessionTitle(session?.title, existing.providerId)) {
        if (existing.providerId === "antigravity") {
          const title = resolveDisplaySessionTitle(sessionId, existing.providerId, session?.title);
          if (title) {
            broadcast(sessionId, { type: "title_updated", title });
            if (session) session.title = title;
          }
        } else {
          sdkListSessions({ dir: projectPath, limit: 50 }).then((sessions) => {
            const found = sessions.find((s) => s.sessionId === sessionId);
            const dbTitle = getSessionTitle(found?.sessionId ?? sessionId);
            const title = dbTitle ?? found?.customTitle ?? found?.summary;
            if (title) {
              broadcast(sessionId, { type: "title_updated", title });
              if (session) session.title = title;
            }
          }).catch(() => {});
        }
      }
      log.debug(`session=${sessionId} FE reconnected (phase=${existing.phase}, clients=${existing.clients.size})`);
      return;
    }

    // New session entry
    createSessionEntry(sessionId, providerId, projectPath, projectName, ws);

    // Resuming a session whose team already exists on disk (server restart, or a
    // team created many turns ago) — re-attach the watcher.
    void detectImplicitTeam(sessionId);

    ws.send(JSON.stringify({
      type: "session_state",
      sessionId,
      phase: "idle",
      pendingApproval: null,
      sessionTitle: resolveDisplaySessionTitle(sessionId, providerId, session?.title),
      compactStatus: null,
      model: resolveSessionModel(sessionId),
      turnStop: lastTurnStop(sessionId),
    }));

    // Async: resolve title from SDK if in-memory title is generic (DB title takes priority)
    if (isGenericSessionTitle(session?.title, providerId)) {
      if (providerId === "antigravity") {
        const title = resolveDisplaySessionTitle(sessionId, providerId, session?.title);
        if (title) {
          broadcast(sessionId, { type: "title_updated", title });
          if (session) session.title = title;
        }
      } else {
        sdkListSessions({ dir: projectPath, limit: 50 }).then((sessions) => {
          const found = sessions.find((s) => s.sessionId === sessionId);
          const dbTitle = getSessionTitle(found?.sessionId ?? sessionId);
          const title = dbTitle ?? found?.customTitle ?? found?.summary;
          if (title) {
            broadcast(sessionId, { type: "title_updated", title });
            if (session) session.title = title;
          }
        }).catch(() => {});
      }
    }
  },

  async message(ws: ChatWsSocket, msg: string | ArrayBuffer | Uint8Array) {
    const { sessionId } = ws.data;
    const text =
      typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer);

    let parsed: ChatWsClientMessage;
    try {
      parsed = JSON.parse(text) as ChatWsClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    // A device answering an AI tab tool (see deliverTabOpen). Settles only a call pending
    // for this very session; anything else is dropped without a reply.
    if (parsed.type === "tab_open_result") {
      const result = parseTabOpenResult(parsed);
      if (result) tabOpenBroker.settle(sessionId, result);
      return;
    }

    // Reject invalid references before creating entries, changing model or resolving approval.
    if (parsed.type === "message" && parsed.replyTo != null) {
      const clientMessageId = typeof parsed.clientMessageId === "string" && parsed.clientMessageId.length <= 128 ? parsed.clientMessageId : undefined;
      const reply = validateReply(parsed.replyTo);
      const expectedProvider = activeSessions.get(sessionId)?.providerId
        ?? chatService.getSession(sessionId)?.providerId ?? getSessionProvider(sessionId) ?? providerRegistry.getDefault().id;
      if (!reply || reply.sessionId !== sessionId || reply.providerId !== expectedProvider) {
        ws.send(JSON.stringify({ type: "message_rejected", clientMessageId, content: parsed.content, replyTo: reply, message: "Invalid reply reference for this session" }));
        return;
      }
      const slash = typeof parsed.content === "string" ? parsed.content.trimStart().match(/^\/(\S+)/) : null;
      if (slash) {
        const { isPpmHandled } = await import("../../services/slash-discovery/index.ts");
        if (isPpmHandled(slash[1]!)) {
          ws.send(JSON.stringify({ type: "message_rejected", clientMessageId, content: parsed.content, replyTo: reply, message: "Cancel reply before running a built-in command" }));
          return;
        }
      }
      parsed.replyTo = reply;
    }

    // Turn references are checked here, where the browser's own fields arrive; only what passes
    // is encoded into the message and granted to this session's AI (see recordTurnGrants below).
    // An empty list is a composer with no chips, not a malformed reference.
    if (parsed.type === "message" && Array.isArray(parsed.turnRefs) && parsed.turnRefs.length === 0) parsed.turnRefs = null;
    if (parsed.type === "message" && parsed.turnRefs != null) {
      const projectNames = new Set(configService.get("projects").map((p) => p.name));
      const refs = validateTurnRefs(parsed.turnRefs, (name) => projectNames.has(name));
      if (!refs) {
        const clientMessageId = typeof parsed.clientMessageId === "string" && parsed.clientMessageId.length <= 128 ? parsed.clientMessageId : undefined;
        ws.send(JSON.stringify({ type: "message_rejected", clientMessageId, content: parsed.content, replyTo: parsed.replyTo ?? null, turnRefs: null, message: "Invalid turn reference" }));
        return;
      }
      // A built-in command never reaches the AI, so references sent with it would be granted
      // for nothing; handed back like a reply is, so the composer can show them again.
      const slash = typeof parsed.content === "string" ? parsed.content.trimStart().match(/^\/(\S+)/) : null;
      if (slash) {
        const { isPpmHandled } = await import("../../services/slash-discovery/index.ts");
        if (isPpmHandled(slash[1]!)) {
          const clientMessageId = typeof parsed.clientMessageId === "string" && parsed.clientMessageId.length <= 128 ? parsed.clientMessageId : undefined;
          ws.send(JSON.stringify({ type: "message_rejected", clientMessageId, content: parsed.content, replyTo: parsed.replyTo ?? null, turnRefs: refs, message: "Remove turn references before running a built-in command" }));
          return;
        }
      }
      parsed.turnRefs = refs;
    }

    let entry = activeSessions.get(sessionId);

    // Auto-create entry if missing — handles: message before open (Bun race), or session cleaned up
    if (!entry) {
      const { projectName: pn, providerHint } = ws.data;
      // Same order as open(): a message can beat it here (the Bun race above), and
      // without the hint a new claude session on a codex-default install would run
      // its first turn through codex.
      adoptProviderHint(sessionId, providerHint);
      const pid = resolveStoredProvider(sessionId) ?? providerRegistry.getDefault().id;
      let pp: string | undefined;
      if (pn) { try { pp = resolveProjectPath(pn); } catch { reportUnregisteredProject(sessionId, pn); } }
      entry = createSessionEntry(sessionId, pid, pp, pn, ws);
      log.info(`session=${sessionId} auto-created entry in message handler`);
    }

    // Ensure ws is in clients set
    if (!entry.clients.has(ws)) {
      attachClient(entry, ws);
    }

    const providerId = entry.providerId ?? providerRegistry.getDefault().id;

    // Client-initiated handshake — FE sends "ready" after onopen.
    // Re-send status so tunnel connections (Cloudflare) that missed the
    // open-handler message still get connected/status confirmation.
    if (parsed.type === "ready" || parsed.type === "resync") {
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: entry.phase,
        pendingApproval: entry.pendingApprovalEvent ?? null,
        sessionTitle: resolveDisplaySessionTitle(sessionId, entry.providerId, chatService.getSession(sessionId)?.title),
        compactStatus: entry.compactStatus ?? null,
        mcpNeedsAuth: entry.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        effortStatus: resolveEffortStatus(sessionId, entry),
        thinking: resolveSessionThinkingEnabled(sessionId),
        promptCache: promptCacheSnapshot(sessionId, entry),
        turnStop: entry.phase === "idle" ? lastTurnStop(sessionId) : null,
        turnBindings: entry.turnBindings ?? [],
      }));
      if (entry.phase !== "idle") {
        sendTurnEvents(sessionId, ws);
      }
      // Replay background-shell registry so a reconnecting client repopulates its bar.
      const shells = backgroundShellRegistry.list(sessionId);
      if (shells.length > 0) {
        ws.send(JSON.stringify({ type: "background_registry", sessionId, shells }));
      }
      return;
    }

    if (parsed.type === "message") {
      // Taken before any awaited work below (slash rewrites, resume), which is part of the wait.
      const messageReceivedAt = Date.now();
      // Images count as content: a message may carry only a picture, with nothing typed.
      const hasInlineImages = Array.isArray((parsed as { images?: unknown }).images)
        && ((parsed as { images: unknown[] }).images.length > 0);
      if (typeof parsed.content !== "string" || (!parsed.content.trim() && !hasInlineImages)) {
        ws.send(JSON.stringify({ type: "error", message: "Message content is required" }));
        return;
      }
      // Validate image payload
      if (parsed.images?.length) {
        if (parsed.images.length > 5) {
          ws.send(JSON.stringify({ type: "error", message: "Max 5 images per message" }));
          return;
        }
        const MAX_BASE64_SIZE = 7_000_000; // ~5MB decoded
        const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
        for (const img of parsed.images) {
          if (img.data.length > MAX_BASE64_SIZE) {
            ws.send(JSON.stringify({ type: "error", message: "Image too large (max 5MB)" }));
            return;
          }
          if (!SUPPORTED_TYPES.has(img.mediaType)) {
            ws.send(JSON.stringify({ type: "error", message: `Unsupported image type: ${img.mediaType}` }));
            return;
          }
        }
      }
      const provider = providerRegistry.get(providerId);
      // A provider that cannot take a message mid-turn would drop it, so the sender is told
      // instead. The message still answers a pending approval, as it does for every provider.
      if (entry.isStreamingActive && !(provider && "pushMessage" in provider)) {
        declinePendingApproval(sessionId, entry);
        ws.send(JSON.stringify({
          type: "error",
          message: "This provider can't take a message while it's working. Wait for the reply, or press Stop.",
        }));
        return;
      }

      // Store permission mode — sticky for this session
      if (parsed.permissionMode) {
        entry.permissionMode = parsed.permissionMode;
        // A design session keeps its mode for callers that pass none (CLI, scheduler), so
        // the one the user picked here is written back rather than living in this socket.
        if (VALID_PERMISSION_MODES.includes(parsed.permissionMode as typeof VALID_PERMISSION_MODES[number])
          && getSessionDesignSlug(sessionId)) {
          setSessionPermissionMode(sessionId, parsed.permissionMode);
        }
      }
      // Store model override — sticky for this session
      if (parsed.model) {
        entry.model = parsed.model;
        setSessionModel(sessionId, parsed.model);
      }
      // Effort/thinking picked on a draft chat (before the WS existed) ride along on the
      // first message so they persist like the model does. Reject invalid effort ("extra").
      if (parsed.effort && VALID_EFFORT_VALUES.includes(parsed.effort as typeof VALID_EFFORT_VALUES[number])) {
        setSessionEffort(sessionId, parsed.effort);
      }
      if (typeof parsed.thinking === "boolean") {
        setSessionThinking(sessionId, parsed.thinking ? THINKING_ADAPTIVE : 0);
      }

      // Kits that self-namespace their skills (AgentKit's `/ak:debug`) publish a
      // name the runtime never registers — it names plugin items after the plugin
      // and directory instead. Rewrite before the echo so every consumer (other
      // devices, the stored transcript, the SDK) sees the name that actually ran.
      const typedContent = parsed.content.trimStart();
      if (typedContent.startsWith("/")) {
        const { listSlashItems, rewriteSlashAlias } = await import("../../services/slash-discovery/index.ts");
        const canonical = rewriteSlashAlias(typedContent, listSlashItems(entry.projectPath ?? "", providerId));
        if (canonical !== typedContent) parsed.content = canonical;
      }

      // Providers with their own skill runtime may not use a leading slash.
      // Codex resolves a skill from a `$name` mention in the prompt; sent as
      // `/imagegen` it is inert prose, so the picked skill would silently not
      // run. Rewritten before the echo for the same reason as the alias above:
      // other devices and the stored transcript must show what actually ran.
      await rewriteProviderSkillSigil(parsed, providerId, sessionId);
      // A person sent these references from an authenticated browser: the one moment this
      // session's AI is granted their turns in other projects. Never derived from message text.
      // An in-process caller (a script schedule) sets `ws.data.origin`; only a browser grants.
      if (!ws.data.origin && parsed.turnRefs?.length) recordTurnGrants(sessionId, parsed.turnRefs);
      // The typed text has its block markers broken, so the only blocks that decode are these.
      parsed.content = encodeMessageBlocks(parsed.content, { turnRefs: parsed.turnRefs, replyTo: parsed.replyTo, ownProject: entry.projectName || undefined });
      // The sender drew its own copy of this message before sending. Hand it the text as it now
      // stands, so the copy matches the transcript, the echo and a replay byte for byte.
      if (typeof parsed.clientMessageId === "string" && parsed.clientMessageId.length <= 128) {
        ws.send(JSON.stringify({ type: "message_accepted", clientMessageId: parsed.clientMessageId, content: parsed.content }));
      }

      // The browser's own id for this message, handed back on the `turn_started` it opens.
      const clientMessageId = typeof parsed.clientMessageId === "string" && parsed.clientMessageId.length <= 128
        ? parsed.clientMessageId : undefined;

      // Echo the user message to OTHER connected clients (second device/tab).
      // The sender renders it optimistically; without this echo a live-connected
      // second device only sees the assistant stream for this turn.
      // A message sent while a turn ran drew no bubble anywhere: it is shown when it goes in.
      const drewNothing = parsed.queued === true;
      if (entry.clients.size > 1 && !drewNothing) {
        echoUserMessage(entry, parsed.content, { except: ws, clientMessageId, imageCount: parsed.images?.length ?? 0 });
      }

      // Intercept PPM-handled built-in commands (e.g. /skills, /version)
      const content = parsed.content.trim();
      const slashMatch = content.match(/^\/(\S+)/);
      if (slashMatch) {
        const { isPpmHandled, executeBuiltin } = await import("../../services/slash-discovery/index.ts");
        const cmdName = slashMatch[1]!;
        if (isPpmHandled(cmdName)) {
          const response = executeBuiltin(cmdName, entry.projectPath ?? "");
          if (response) {
            broadcast(sessionId, { type: "text", content: response });
            broadcast(sessionId, { type: "done", resultSubtype: "builtin", numTurns: 0 });
            return;
          }
        }
      }

      // An in-process caller (a script schedule) reaches this handler with `ws.data.origin` set;
      // a browser socket leaves it unset. Only a person writing resets the session's pair limits
      // and ends its waits: a script posting into a session that orchestrates others must not
      // cancel its `send_to_session` wait, nor let two AI sessions loop past the limit the user set.
      if (!ws.data.origin) {
        // Every pair of sessions this one is in may message each other automatically again.
        pairCounter.resetForSession(sessionId);
        // The person wrote to a session waiting on another: its wait ends, and it reads the person.
        collabWaits.cancelWaiter(sessionId);
      }

      const submitting = entry;
      await withSessionLock(sessionId, () => submitToSession(sessionId, submitting, parsed.content, {
        origin: ws.data.origin ?? "ws",
        clientMessageId,
        images: parsed.images,
        imagePaths: parsed.imagePaths,
        priority: parsed.priority ?? "next",
        sender: ws,
        receivedAt: messageReceivedAt,
        supersedePendingApproval: true,
        ...(drewNothing ? { echoOnHandOff: true, echoToSender: true } : {}),
        ...(drewNothing && parsed.sendNow === true ? { sendNow: true } : {}),
      }));
    } else if (parsed.type === "set_model") {
      // Persist per-session model override. If an idle subprocess is alive,
      // abort it so the next message recreates the query with the new model
      // (history preserved via the resume path). No-op if already streaming.
      if (!parsed.model || typeof parsed.model !== "string") {
        ws.send(JSON.stringify({ type: "error", message: "model is required" }));
        return;
      }
      entry.model = parsed.model;
      setSessionModel(sessionId, parsed.model);
      // Its levels and limits were the old model's; the settings files stand in until the next turn asks.
      entry.effortStatus = undefined;
      const provider = providerRegistry.get(providerId);
      const hasLiveStream = provider?.hasStreamingSession?.(sessionId) ?? false;
      // Only abort when idle between turns — never interrupt an active turn.
      // Aborting the idle-but-alive subprocess forces the next message to take
      // the resume path, recreating the query with the new model.
      if (hasLiveStream && entry.phase === "idle") {
        chatService.abortQuery(providerId, sessionId, "set_model", "ws");
      }
      log.info(`session=${sessionId} model switched to ${parsed.model}`);
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: entry.phase,
        pendingApproval: entry.pendingApprovalEvent ?? null,
        sessionTitle: chatService.getSession(sessionId)?.title || null,
        compactStatus: entry.compactStatus ?? null,
        mcpNeedsAuth: entry.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        effortStatus: resolveEffortStatus(sessionId, entry),
        thinking: resolveSessionThinkingEnabled(sessionId),
      }));
    } else if (parsed.type === "set_effort") {
      // Per-session effort override. Reject anything outside the SDK enum — notably
      // "extra" (UI label maps to "xhigh"), which would crash the CLI subprocess.
      if (!parsed.effort || !VALID_EFFORT_VALUES.includes(parsed.effort as typeof VALID_EFFORT_VALUES[number])) {
        ws.send(JSON.stringify({ type: "error", message: `effort must be one of: ${VALID_EFFORT_VALUES.join(", ")}` }));
        return;
      }
      setSessionEffort(sessionId, parsed.effort);
      const provider = providerRegistry.get(providerId);
      // Abort only when idle-but-alive so the next turn recreates the query with the new
      // effort (mirror set_model); never interrupt an active turn.
      if ((provider?.hasStreamingSession?.(sessionId) ?? false) && entry.phase === "idle") {
        chatService.abortQuery(providerId, sessionId, "set_effort", "ws");
      }
      log.info(`session=${sessionId} effort switched to ${parsed.effort}`);
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: entry.phase,
        pendingApproval: entry.pendingApprovalEvent ?? null,
        sessionTitle: chatService.getSession(sessionId)?.title || null,
        compactStatus: entry.compactStatus ?? null,
        mcpNeedsAuth: entry.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        effortStatus: resolveEffortStatus(sessionId, entry),
        thinking: resolveSessionThinkingEnabled(sessionId),
      }));
    } else if (parsed.type === "set_thinking") {
      // Per-session thinking toggle. ON = adaptive (model picks depth, guided by effort),
      // OFF = 0 (explicit, overrides provider config). Abort idle like set_model.
      setSessionThinking(sessionId, parsed.enabled ? THINKING_ADAPTIVE : 0);
      const provider = providerRegistry.get(providerId);
      if ((provider?.hasStreamingSession?.(sessionId) ?? false) && entry.phase === "idle") {
        chatService.abortQuery(providerId, sessionId, "set_thinking", "ws");
      }
      log.info(`session=${sessionId} thinking ${parsed.enabled ? "on" : "off"}`);
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: entry.phase,
        pendingApproval: entry.pendingApprovalEvent ?? null,
        sessionTitle: chatService.getSession(sessionId)?.title || null,
        compactStatus: entry.compactStatus ?? null,
        mcpNeedsAuth: entry.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        effortStatus: resolveEffortStatus(sessionId, entry),
        thinking: resolveSessionThinkingEnabled(sessionId),
      }));
    } else if (parsed.type === "cancel") {
      // Fully teardown streaming session — user must resume to continue
      const phase = entry?.phase ?? "unknown";
      log.info(`session=${sessionId} WS cancel received from FE (phase=${phase})`);
      ppmApprovals.cancelSession(sessionId, "The user stopped the chat before approving, so nothing ran.");
      // Stop covers this session only: its waits end, the sessions it waits for run on.
      collabWaits.cancelWaiter(sessionId);
      chatService.abortQuery(providerId, sessionId, "ws_cancel", ws.data.origin ?? "ws");
    } else if (parsed.type === "queue_take_back") {
      const id = typeof parsed.id === "string" ? parsed.id : "";
      const taken = entry ? await takeBackQueued(entry, id, queueDeps(sessionId, entry)) : undefined;
      // Only the asking device gets the text back for its composer; every device saw the queue change.
      ws.send(JSON.stringify(taken
        ? { type: "queue_taken_back", id, content: taken.content, imageCount: taken.imageCount }
        : { type: "queue_taken_back", id, error: "The AI has already started reading it" }));
    } else if (parsed.type === "queue_send_now") {
      if (entry) await sendQueueNow(sessionId, entry);
    } else if (parsed.type === "kill_background_shell") {
      // Kill via the AI: enqueue an instruction so the model calls KillShell.
      // Cross-platform and safe (no OS-PID guessing). Runs when the AI is idle
      // between turns, so the UI shows a "stopping" state until then.
      const shellId = parsed.shellId;
      const shell = backgroundShellRegistry.get(sessionId, shellId);
      // Ignore if unknown or already stopping/stopped (avoids duplicate KillShell turns).
      if (!shell || shell.status !== "running") return;
      backgroundShellRegistry.setStatus(sessionId, shellId, "stopping");
      broadcastBackgroundRegistry(sessionId);
      const provider = providerRegistry.get(providerId);
      const instruction = `Call the KillShell tool with task_id "${shellId}" to stop that background command, then reply with just "Stopped.".`;
      if (!entry.isStreamingActive || entry.phase === "idle") {
        entry.turnRequestedAt = { at: Date.now(), cold: !entry.isStreamingActive };
      }
      if (!entry.isStreamingActive) {
        if (provider && "resumeSession" in provider) {
          try {
            await (provider as any).resumeSession(sessionId);
          } catch (e) {
            log.error(`session=${sessionId} resume failed provider=${providerId} (kill_background_shell shellId=${shellId}):`, e);
            return;
          }
        }
        if (entry.projectPath && provider && "ensureProjectPath" in provider) {
          (provider as any).ensureProjectPath(sessionId, entry.projectPath);
        }
        entry.turnEvents = [];
        setPhase(sessionId, "initializing");
        const permMode = entry.permissionMode;
        const msgModel = entry.model;
        entry.streamPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            startSessionConsumer(sessionId, providerId, instruction, permMode, undefined, msgModel).then(resolve, resolve);
          }, 0);
        });
      } else if (provider && "pushMessage" in provider) {
        try {
          await chatService.pushMessage(providerId, sessionId, instruction, { priority: "next", origin: "ws" });
        } catch (e) {
          log.error(`session=${sessionId} follow-up failed provider=${providerId} (kill_background_shell shellId=${shellId}):`, e);
          return;
        }
        entry.turnEvents = [];
        // The instruction answers no approval, so one on screen stays there: emptying the slot
        // would leave the provider waiting on a request no device can answer.
        setPhase(sessionId, "thinking");
      }
      log.info(`session=${sessionId} kill_background_shell requested shellId=${shellId}`);
    } else if (parsed.type === "approval_response") {
      // PPM's own approvals (database changes, session tools' cards) are answered over HTTP, never here.
      if (ppmApprovals.has(parsed.requestId)) return;
      chatService.resolveApproval(providerId, sessionId, parsed.requestId, parsed.approved, (parsed as any).data, { origin: "ws" });
      if (entry) {
        // Enrich the buffered approval_request with response data so replayed
        // events render correctly (e.g. AskUserQuestion shows answered state)
        const respData = (parsed as any).data;
        for (let i = entry.turnEvents.length - 1; i >= 0; i--) {
          const buffered = entry.turnEvents[i] as any;
          if (buffered.type === "approval_request" && buffered.requestId === parsed.requestId) {
            buffered.approved = parsed.approved;
            if (buffered.tool === "AskUserQuestion" && respData) {
              buffered.input = { ...buffered.input, answers: respData };
            }
            break;
          }
        }
        // Tell every connected device this approval was resolved so their live
        // prompt clears — even the device that didn't answer. Without this a
        // second device keeps showing the (now dead) question card.
        broadcast(sessionId, {
          type: "approval_resolved",
          requestId: parsed.requestId,
          approved: parsed.approved,
          answers: (parsed as any).data ?? null,
        });
        // Broadcast approval cleared to all clients
        broadcast(sessionId, { type: "phase_changed", phase: entry.phase });
        // After the broadcasts above, so a request shown next is not cleared with them. An answer
        // to a request still in line (a device holding an older card) only takes it out of line:
        // emptying the slot then would hide the card that is still unanswered.
        const holder = entry.pendingApprovalEvent;
        if (!holder || holder.requestId === parsed.requestId) clearPendingApproval(sessionId, entry);
        else entry.queuedApprovals = entry.queuedApprovals?.filter((queued) => queued.requestId !== parsed.requestId);
      }
    }
  },

  close(ws: ChatWsSocket) {
    const { sessionId } = ws.data;
    const entry = activeSessions.get(sessionId);
    if (!entry) return;

    // Remove from clients Set + clear per-client ping
    evictClient(entry, ws);
    log.debug(`session=${sessionId} FE disconnected (phase=${entry.phase}, clients=${entry.clients.size})`);

    if (entry.clients.size === 0) {
      // No clients listening anymore. The streaming query is NOT torn down here: a
      // disconnect is usually a refresh, a phone switching apps or a laptop sleeping,
      // and the client is back within seconds. Killing the subprocess on the spot forces
      // the next message down the resume path, which replays the whole transcript and
      // re-picks an account — on a large session that turns a cache read into a full
      // cache write. The cleanup timer does the teardown once the session is genuinely
      // abandoned (see startCleanupTimer), and enforceWarmIdleCap bounds how many
      // subprocesses may wait out that timer at once.
      entry.idleSince = Date.now();
      startCleanupTimer(sessionId);
      scheduleSubprocessRelease(sessionId);
      enforceWarmIdleCap();
    }
  },
};
