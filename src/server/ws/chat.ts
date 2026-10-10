import { encodeReply, validateReply } from "../../shared/chat-reply.ts";
import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveChatProjectPath } from "../helpers/resolve-chat-project.ts";
import { logSessionEvent } from "../../services/session-log.service.ts";
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { getSessionTitle, incrementSessionUnread, clearSessionUnread, getSessionUnreadCount, getSessionModel, setSessionModel, getSessionProvider, setSessionProvider, getSessionEffort, setSessionEffort, getSessionThinking, setSessionThinking, setSessionMigratedTo, resolveMigratedSession, setSessionPermissionMode, getLastTurnCacheState } from "../../services/db.service.ts";
import { VALID_PERMISSION_MODES } from "../../types/config.ts";
import { VALID_EFFORT_VALUES, THINKING_ADAPTIVE, isThinkingEnabled } from "../../providers/claude-agent-sdk-query-options.ts";
import type { ChatWsClientMessage, SessionPhase } from "../../types/api.ts";
// File watching and app-wide broadcasts are owned by the global WS (`./global.ts`)
// — a chat socket is not guaranteed to exist now that chat tabs mount lazily.
import { broadcastGlobalEvent } from "./global.ts";
import { bashOutputSpy } from "../../services/bash-output-spy.ts";
import { nestedSubagentSpy } from "../../services/nested-subagent-spy.ts";
import { resolveSessionDir } from "../../services/subagent-transcript-merger.ts";
import { backgroundShellRegistry } from "../../services/background-shell-registry.ts";
import { basename } from "node:path";
import { configService } from "../../services/config.service.ts";
import { formatTurnUsageLog, prefixTokens } from "../../shared/turn-usage.ts";
import type { PromptCacheState } from "../../shared/prompt-cache-idle.ts";
import { isAsyncAgentLaunchAck, isTerminalAgentStatus } from "../../shared/background-agent-status.ts";
import { cacheReleaseDelayMs, selectWarmIdleEvictions } from "../../services/subprocess-retention.ts";
import { needsAuthServerNames } from "../../services/mcp-oauth/mcp-oauth-redirect.ts";
import { mcpStatusEvent, registerMcpSignInSync } from "./chat-mcp-sign-in-sync.ts";
import { claudeTranscriptExists } from "../../services/claude-transcript-exists.ts";
import { registerMemoryGauge } from "../../services/memory-diagnostics.ts";
import { setTabOpenDelivery, tabOpenBroker } from "../../services/tab-tools-mcp/tab-open-broker.ts";
import { parseTabOpenResult } from "../../shared/tab-open-protocol.ts";
import { assistantUiBroker, setAssistantUiDelivery } from "../../services/assistant-mcp/assistant-ui-tools.ts";
import { parseAssistantUiResult, type UiSummary } from "../../shared/assistant-ui-protocol.ts";
import { readLastTurnStop } from "../../services/session-trace/turn-stop-reader.ts";
import { describeTurnStop, type TurnStop } from "../../shared/turn-stop.ts";
import { createLogger } from "../../services/logger.ts";
import { APPROVAL_END, createPendingApprovals, isEndpointApproval, type PendingApprovalEvent } from "./chat-pending-approval.ts";
import { announceApprovalRequest } from "./chat-approval-notification.ts";
import { assistantApprovalBroker, setAssistantApprovalDelivery } from "../../services/assistant-mcp/assistant-approval-broker.ts";
import { APPROVAL_NO_LONGER_VALID_MESSAGE, type ApprovalStaleMessage } from "../../shared/assistant-approval.ts";
import {
  effectivePermissionMode, targetChatMode, type ChatDeliveryState,
} from "./chat-deliver-user-message.ts";
import { setAssistantChatDelivery, TARGET_HAS_PENDING_APPROVAL, type DeliverResult } from "../../services/assistant-mcp/assistant-chat-send.ts";
import { isAssistantSession } from "../../services/assistant/assistant-session.ts";
import { assistantProviderDefaults } from "../../services/assistant/assistant-settings.service.ts";
import type { TraceOrigin } from "../../shared/session-trace.ts";
import type { ReplyReference } from "../../shared/chat-reply.ts";
import { CHAT_CLIENT_ID_PARAM, chatClientIdFrom } from "../../shared/chat-client-id.ts";
import {
  CHAT_BUSY, setChatControl, type ChatMessageOrigin, type LiveApprovalCard, type LiveChatState, type ServerOrigin,
} from "../../services/chat-control/chat-control.ts";
import { chatLifecycle } from "../../services/chat-control/chat-lifecycle.ts";
import { isNotificationSuppressed } from "../../services/chat-control/notification-suppressor.ts";

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
function sessionProviderId(sessionId: string): string {
  return activeSessions.get(sessionId)?.providerId
    ?? resolveStoredProvider(sessionId)
    ?? configService.get("ai").default_provider ?? "claude";
}

function sessionProviderConfig(sessionId: string) {
  return configService.get("ai").providers[sessionProviderId(sessionId)];
}

/**
 * The model and effort an Assistant session starts with, from Settings → PPM Assistant, which
 * stand in for the chat defaults; `{}` for any other session.
 */
function assistantSessionDefaults(sessionId: string): { model?: string; effort?: string } {
  return isAssistantSession(sessionId) ? assistantProviderDefaults(sessionProviderId(sessionId)) : {};
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
  return getSessionModel(sessionId) ?? assistantSessionDefaults(sessionId).model ?? sessionProviderConfig(sessionId)?.model;
}

/** Resolve the effort shown in session_state: per-session override, else provider default. */
function resolveSessionEffort(sessionId: string): string | undefined {
  return getSessionEffort(sessionId) ?? assistantSessionDefaults(sessionId).effort ?? sessionProviderConfig(sessionId)?.effort;
}

/** Whether thinking is effectively ON: per-session override wins, else provider config, else SDK default. */
function resolveSessionThinkingEnabled(sessionId: string): boolean {
  return isThinkingEnabled(
    getSessionThinking(sessionId),
    sessionProviderConfig(sessionId)?.thinking_budget_tokens,
  );
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

type ChatWsSocket = {
  /** `clientId`: the browser tab, kept across its reconnects (see `shared/chat-client-id.ts`). */
  data: { type: string; sessionId: string; projectName?: string; providerHint?: string; clientId?: string };
  send: (data: string) => void;
  ping?: (data?: string | ArrayBuffer) => void;
};

/**
 * What a chat socket carries, read from its upgrade URL (`/ws/project/<p>/chat/<id>?...`). The one
 * place that query is read, so every server that upgrades chat sockets (`src/server/index.ts` and
 * the e2e fixtures) agrees on it: a copy that forgot `clientId` left every socket without one, and
 * the chatting tab was lost on every Codex rename however the browser reconnected.
 */
export function chatSocketData(sessionId: string, projectName: string, query: URLSearchParams) {
  return {
    type: "chat" as const,
    sessionId,
    projectName,
    // A hint only: the handler adopts it when the session has no stored provider, so a tab that
    // knows it is a claude chat cannot be resumed as whatever the install's default provider is.
    providerHint: query.get("providerId") ?? undefined,
    // Which tab this is, so a reconnect is recognised; a routing hint, never a credential.
    clientId: chatClientIdFrom(query.get(CHAT_CLIENT_ID_PARAM)),
  };
}

interface SessionEntry {
  providerId: string;
  clients: Set<ChatWsSocket>;
  projectPath?: string;
  projectName?: string;
  pingIntervals: Map<ChatWsSocket, ReturnType<typeof setInterval>>;
  phase: SessionPhase;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  /** The approval card the session shows; only `chat-pending-approval.ts` changes it. */
  pendingApprovalEvent?: PendingApprovalEvent;
  /** Approval cards waiting behind the shown one, oldest first. */
  approvalQueue?: PendingApprovalEvent[];
  turnEvents: unknown[];
  /** The opening of the turn's last top-level text block — the answer a "Chat completed" notification quotes. */
  finalText?: string;
  /** The user message that initiated the current turn (for reconnect replay) */
  currentUserMessage?: string;
  streamPromise?: Promise<void>;
  permissionMode?: string;
  /** The mode the running subprocess was started in; set while `isStreamingActive`. */
  liveMode?: string;
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
  /** Pending release of the subprocess once its prompt cache lapses */
  cacheReleaseTimer?: ReturnType<typeof setTimeout>;
  /** The socket whose message opened the latest turn: where the AI's tab tools open a tab. */
  lastSender?: ChatWsSocket;
  /**
   * The tab that socket belongs to. Outlives the socket: when the tab reconnects (a network blip,
   * or a Codex rename reopening it under the thread id) its new socket is the chatting device.
   * Moves with the entry when the session is re-keyed.
   */
  lastSenderClientId?: string;
  /** Events broadcast with no client attached since the session last went idle — logged then, as one count. */
  droppedEvents?: number;
}

/** Sessions with no client attached, not mid-turn, still holding a live subprocess. */
function listWarmIdleSessions(): { sessionId: string; entry: SessionEntry; idleSince?: number }[] {
  const out: { sessionId: string; entry: SessionEntry; idleSince?: number }[] = [];
  for (const [sessionId, entry] of activeSessions) {
    if (entry.clients.size > 0 || entry.isStreamingActive) continue;
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
  if (entry.clients.size > 0 || entry.isStreamingActive) return;
  const provider = providerRegistry.get(entry.providerId);
  if (!provider?.hasStreamingSession?.(sessionId)) return;
  chatService.abortQuery(entry.providerId, sessionId, reason, "ws");
  log.info(`session=${sessionId} released subprocess (${reason})`);
  logSessionEvent(sessionId, "INFO", note);
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
  log.info(`session=${sessionId} released subprocess (${reason})`);
  logSessionEvent(sessionId, "INFO", note);
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
 * Hands an AI tool's request to the device that sent the turn's message — the one the user is
 * talking from. When that socket has gone, a non-`strict` call goes to every device showing the
 * chat and the first answer settles it: harmless for opening a tab. A `strict` call goes only to
 * the same tab's new socket if it reconnected, and otherwise nowhere (a locked phone, a closed
 * laptop), because the PPM Assistant's UI operations (switching project, running a command)
 * must never happen on a screen nobody is talking from.
 * Never buffered into `turnEvents`: a device that reconnects later must not act on it again.
 * Returns how many sockets it went to.
 */
export function deliverToChattingDevice(sessionId: string, payload: object, opts: { strict: boolean }): number {
  const entry = activeSessions.get(sessionId);
  if (!entry) return 0;
  const json = JSON.stringify(payload);
  const sendTo = (clients: Iterable<ChatWsSocket>): number => {
    let sent = 0;
    for (const client of [...clients]) {
      try { client.send(json); sent++; } catch { evictClient(entry, client); }
    }
    return sent;
  };
  if (entry.lastSender && entry.clients.has(entry.lastSender) && sendTo([entry.lastSender]) > 0) return 1;
  if (!opts.strict) return sendTo(entry.clients);
  // The sender's socket is gone; the same tab reconnected is still the device the user is
  // talking from. One socket only, even if a duplicated tab carries the same id.
  const id = entry.lastSenderClientId;
  for (const client of id ? [...entry.clients] : []) {
    if (client.data.clientId === id && sendTo([client]) > 0) return 1;
  }
  return 0;
}
setTabOpenDelivery((sessionId, request) => deliverToChattingDevice(sessionId, request, { strict: false }), resolveMigratedSession);
setAssistantUiDelivery((sessionId, request) => deliverToChattingDevice(sessionId, request, { strict: true }), resolveMigratedSession);

/** The card as a caller outside the socket layer sees it. */
function liveApprovalCard(ev: PendingApprovalEvent): LiveApprovalCard {
  return {
    requestId: ev.requestId,
    tool: ev.tool,
    input: ev.input,
    ...(ev.summary ? { summary: ev.summary } : {}),
    isQuestion: ev.tool === "AskUserQuestion",
  };
}

/** Who is answering a card right now (see answerApprovalCore); undefined when nobody is. */
let resolvingBy: ChatMessageOrigin | undefined;

/**
 * Every session's approval cards, provider and Assistant endpoint alike, one shown at a time
 * (see `chat-pending-approval.ts`). A card is a question for the user, not a UI command, so it
 * goes to every device showing the session and is kept for one that connects later.
 */
const approvals = createPendingApprovals({
  show: (sessionId, ev) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return;
    bufferAndBroadcast(sessionId, ev);
    chatLifecycle.emit("approval_shown", {
      sessionId, card: liveApprovalCard(ev), projectName: entry.projectName ?? "", providerId: entry.providerId,
    });
    announceApprovalRequest(sessionId, entry, ev, () => activeSessions.get(sessionId)?.pendingApprovalEvent?.requestId === ev.requestId);
    // An endpoint card answers within its own window, counted from now: time spent queued
    // behind another card the user had not answered is not time the user had to answer this one.
    if (isEndpointApproval(ev)) assistantApprovalBroker.shown(ev.requestId);
  },
  announceResolved: (sessionId, requestId, approved, answers) => {
    broadcast(sessionId, { type: "approval_resolved", requestId, approved, answers });
  },
  denyProvider: (sessionId, requestId, reason) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return;
    chatService.resolveApproval(entry.providerId, sessionId, requestId, false, undefined, { reason: reason.code, origin: "ws" });
    logSessionEvent(sessionId, "INFO", `Pending approval ${requestId} refused (${reason.code})`);
  },
  endEndpoint: (requestId, reason) => { assistantApprovalBroker.withdraw(requestId, reason.message); },
  ended: (sessionId, ev, reason, how) => {
    chatLifecycle.emit("approval_resolved", {
      sessionId,
      requestId: ev.requestId,
      approved: how.approved ?? false,
      ...(how.answers != null ? { answers: how.answers } : {}),
      reason: reason.code,
      // Only an answer names who gave it; a card ended by a new turn or a stop was answered by nobody.
      ...(resolvingBy && reason.code === APPROVAL_END.answered.code ? { by: resolvingBy } : {}),
    });
  },
});

setAssistantApprovalDelivery(
  (sessionId, request) => {
    const entry = activeSessions.get(sessionId);
    if (!entry) return 0;
    approvals.offer(sessionId, entry, request);
    return 1;
  },
  // The request ended — answered, timed out or withdrawn — so its card goes, on every device.
  (asked, requestId, approved) => {
    const sessionId = resolveMigratedSession(asked);
    const entry = activeSessions.get(sessionId);
    if (entry && approvals.clear(sessionId, entry, requestId, APPROVAL_END.answered, { approved })) {
      broadcast(sessionId, { type: "phase_changed", phase: entry.phase });
    }
  },
  resolveMigratedSession,
);

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
  // Heard by server-side listeners before the no-client drop below: a turn started from
  // Telegram has no browser attached, and its events still have to reach somebody.
  if (entry) chatLifecycle.emit("stream", { sessionId, event });
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
function startCleanupTimer(sessionId: string): void {
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
    logSessionEvent(sessionId, "INFO", "Session cleaned up (idle, no FE reconnected)");
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
    // A card still here (an endpoint request a background agent made after its turn) could never
    // be shown again: a device reopening the chat gets a fresh entry. End it, so its tool answers
    // "not run" instead of waiting until a restart, and listeners holding the card drop it.
    approvals.clearAll(sessionId, entry, APPROVAL_END.sessionClosed);
    activeSessions.delete(sessionId);
  }, CLEANUP_TIMEOUT_MS);
}

/** Tells server-side listeners a turn is over; the chat is idle by the time this runs. */
function emitTurnEnded(
  sessionId: string,
  entry: SessionEntry,
  outcome: "done" | "stopped" | "failed",
  detail: { finalText?: string; stop?: TurnStop; error?: string },
): void {
  chatLifecycle.emit("turn_ended", {
    sessionId, outcome, ...detail, projectName: entry.projectName ?? "", providerId: entry.providerId,
  });
}

/**
 * Persistent event consumer — runs for the entire session lifetime.
 * First message creates the query; follow-ups push into the provider's
 * message channel. Events from ALL turns flow through this single loop.
 */
async function startSessionConsumer(sessionId: string, providerId: string, content: string, permissionMode?: string, images?: Array<{ data: string; mediaType: string }>, model?: string, imagePaths?: string[], uiSummary?: UiSummary, origin: TraceOrigin = "ws", channel?: "telegram"): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    log.error(`session=${sessionId} startSessionConsumer: no entry — aborting`);
    return;
  }
  log.debug(`session=${sessionId} startSessionConsumer started (clients=${entry.clients.size})`);

  entry.isStreamingActive = true;
  // Both providers fix the mode for the life of the subprocess this starts; a follow-up pushed
  // into it runs in this mode whatever it asked for.
  entry.liveMode = effectivePermissionMode(sessionId, providerId, permissionMode);
  approvals.clearAll(sessionId, entry, APPROVAL_END.turnStarted);
  entry.turnEvents = [];
  entry.nestedBuffered = 0;
  entry.finalText = undefined;
  setPhase(sessionId, "connecting");

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastContextWindowPct: number | undefined;
  /** The throw that ended the loop mid-turn, announced as a failed turn once the chat is idle. */
  let failure: { error: string; stop?: TurnStop } | undefined;

  try {
    const userPreview = content.slice(0, 200);
    logSessionEvent(sessionId, "USER", userPreview);
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
        log.error(`session=${sessionId} SDK connection timeout after ${elapsed}s`);
        logSessionEvent(sessionId, "ERROR", `SDK connection timeout after ${elapsed}s — subprocess may have failed to start`);
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
    for await (const event of chatService.sendMessage(providerId, sessionId, content, { permissionMode, images, ...(imagePaths?.length && { imagePaths }), ...(model && { model }), ...(effortOverride && { effort: effortOverride }), ...(thinkingBudget != null && { thinkingBudget }), ...(uiSummary && { uiSummary }), ...(channel && { channel }), origin })) {
      eventCount++;
      const ev = event as any;
      const evType = ev.type ?? "unknown";
      /** How this event ended the turn, when it is the turn's `done`; announced once the chat is idle. */
      let turnEnd: { stop: TurnStop | null; finalText?: string } | undefined;

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

      // System events → transition connecting → thinking, forward compact events
      if (evType === "system") {
        const sub = (ev as any).subtype;
        if (sub === "init" && Array.isArray(ev.mcpServers)) {
          entry.mcpNeedsAuth = needsAuthServerNames(ev.mcpServers);
          broadcast(sessionId, mcpStatusEvent(entry.mcpNeedsAuth));
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
      const isMetadataEvent = evType === "account_info" || evType === "account_retry" || evType === "streaming_status" || evType === "status_update";
      if (!firstEventReceived && !isMetadataEvent) {
        firstEventReceived = true;
        const requested = entry.turnRequestedAt;
        entry.turnRequestedAt = undefined;
        // A turn nobody sent over this socket (scheduler, remote trigger) has no receipt time.
        const waitMs = Date.now() - (requested?.at ?? startTime);
        const path = requested ? (requested.cold ? "cold" : "warm") : "unsent";
        log.info(`session=${sessionId} first SDK event after ${waitMs}ms: type=${evType} path=${path}`);
        logSessionEvent(sessionId, "PERF", `First SDK event after ${waitMs}ms (type=${evType}, ${path})`);
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

      // Log every event
      if (evType === "text") {
        logSessionEvent(sessionId, "TEXT", ev.content?.slice(0, 500) ?? "");
      } else if (evType === "tool_use") {
        logSessionEvent(sessionId, "TOOL_USE", `${ev.tool} ${JSON.stringify(ev.input).slice(0, 300)}`);
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
        logSessionEvent(sessionId, "TOOL_RESULT", `error=${ev.isError ?? false} ${(ev.output ?? "").slice(0, 300)}`);
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
        logSessionEvent(sessionId, "ERROR", errorDetail);
      } else if (evType === "done") {
        // Turn complete — transition to idle, clear buffer for next turn
        logSessionEvent(sessionId, "DONE", `subtype=${ev.resultSubtype ?? "none"} turns=${ev.numTurns ?? "?"} ctx=${ev.contextWindowPct ?? "?"}%${ev.usage ? ` ${formatTurnUsageLog(ev.usage)}` : ""}`);
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
        // Persist unread to DB + broadcast to all tabs/devices
        const doneSession = chatService.getSession(sessionId);
        // The project comes from the connection, not from a separate write on open: a
        // session PPM did not create has no metadata row until this runs, and this is the
        // one place that knows both the session and its project.
        incrementSessionUnread(sessionId, "done", doneSession?.title, entry.projectName || null);
        broadcastGlobalEvent({ type: "session:unread_changed", sessionId, unreadCount: -1, unreadType: "done", projectName: entry.projectName || "", sessionTitle: doneSession?.title || null });

        // The trace already holds this `done`: ChatService records an event before yielding it.
        // Sent ahead of the `done` itself, so the bar is there the moment the turn goes idle.
        const turnStop = lastTurnStop(sessionId);
        if (turnStop) broadcast(sessionId, { type: "turn_stop", stop: turnStop });
        const stopped = turnStop ? describeTurnStop(turnStop) : null;

        const finalText = entry.finalText;
        turnEnd = { stop: turnStop, finalText };
        // Held back when the user is being told elsewhere (the turn was answered on Telegram);
        // the unread mark above stays either way.
        if (!isNotificationSuppressed(sessionId, "done")) import("../../services/notification.service.ts").then(({ notificationService }) => {
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
        // Shown (buffered, broadcast and notified) now, or queued behind the card already
        // shown — e.g. an Assistant endpoint request — and shown once that one is answered.
        // Never anything the provider says: the card's `origin` is the endpoint's alone.
        const { origin: _origin, summary: _summary, ...providerEvent } = ev;
        approvals.offer(sessionId, entry, providerEvent as PendingApprovalEvent);
        continue;
      } else if (evType === "session_migrated") {
        // CLI providers discover real session ID from CLI output — migrate WS tracking
        const newId = ev.newSessionId as string;
        if (newId && newId !== sessionId) {
          log.info(`session_migrated: ${sessionId} → ${newId}`);
          // Persist the link before re-keying. A tab that opened under the old
          // id keeps it in its own storage, so without this the conversation
          // becomes unreachable from that tab the moment the turn ends.
          setSessionMigratedTo(sessionId, newId);
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
          // The consumer must target the new id for every subsequent broadcast —
          // including this session_migrated event — since the entry moved. Without
          // this, a provider that always migrates (e.g. codex: threadId ≠ ppm id)
          // would have all its stream events dropped.
          const oldId = sessionId;
          sessionId = newId;
          chatLifecycle.emit("migrated", { oldSessionId: oldId, newSessionId: newId });
        }
      } else {
        logSessionEvent(sessionId, evType.toUpperCase(), JSON.stringify(ev).slice(0, 200));
      }

      // Buffer + broadcast content events
      bufferAndBroadcast(sessionId, event);

      // After "done", transition to idle + clear turn buffer for next turn
      // Consumer loop continues — query waits for next message in generator
      if (evType === "done") {
        entry.turnEvents = [];
        entry.nestedBuffered = 0;
        // The provider's own requests ended with its turn. An endpoint card stays: its tool call
        // (a background agent's, say) is still waiting, and ends on its own when it does.
        approvals.clearAll(sessionId, entry, APPROVAL_END.turnEnded, { only: "provider" });
        // Clear stale compact status if turn ended without compact_boundary.
        // SDK may emit `status: compacting` without a matching boundary (deferred,
        // resolved, or errored); without this clear, UI shows stuck "Compacting…".
        if (entry.compactStatus === "compacting") {
          entry.compactStatus = null;
          log.debug(`session=${sessionId} compact_status=done (cleared on turn done without boundary)`);
          broadcast(sessionId, { type: "compact_status", status: "done" });
        }
        setPhase(sessionId, "idle");
        // Reset heartbeat tracking for next turn
        firstEventReceived = false;
        startTime = Date.now();
        // After the idle transition, so a listener reading the chat's state sees it finished.
        emitTurnEnded(sessionId, entry, turnEnd?.stop ? "stopped" : "done", {
          ...(turnEnd?.finalText ? { finalText: turnEnd.finalText } : {}),
          ...(turnEnd?.stop ? { stop: turnEnd.stop } : {}),
        });
      }
    }

    logSessionEvent(sessionId, "INFO", `Session consumer completed (${eventCount} events total)`);
    log.debug(`session=${sessionId} session consumer completed (${eventCount} events)`);
  } catch (e) {
    const errMsg = (e as Error).message;
    log.error(`session=${sessionId} provider=${providerId} consumer failed:`, e);
    logSessionEvent(sessionId, "ERROR", `Exception: ${errMsg}`);
    bufferAndBroadcast(sessionId, { type: "error", message: errMsg });
    // ChatService wrote `run_failed` and flushed the trace before the throw reached here.
    const turnStop = lastTurnStop(sessionId);
    if (turnStop) broadcast(sessionId, { type: "turn_stop", stop: turnStop });
    // Announced by the finally below once the chat is idle; a throw between turns ends none.
    if (entry.phase !== "idle") failure = { error: errMsg, ...(turnStop ? { stop: turnStop } : {}) };
  } finally {
    // A turn still in flight here never got its `done`: the provider threw, or its stream ended
    // mid-turn (a stopped turn usually ends this way).
    const endedMidTurn = entry.phase !== "idle";
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
    entry.liveMode = undefined;
    approvals.clearAll(sessionId, entry, APPROVAL_END.turnEnded);
    if (failure) emitTurnEnded(sessionId, entry, "failed", failure);
    else if (endedMidTurn) emitTurnEnded(sessionId, entry, "stopped", {});
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
    if (entry.clients.size === 0) {
      startCleanupTimer(sessionId);
    }
    log.info(`session=${sessionId} consumer loop ended`);
  }
}

/** How a message reaches {@link deliverUserMessage}, and who sent it. */
interface DeliverOpts {
  /**
   * "ws": a device's message, `sender` being its socket. "assistant": a message the PPM
   * Assistant sends into this chat with the user's approval — it never answers a waiting card
   * on the user's behalf, never makes any device the chat's "chatting device", and is shown to
   * every device showing the chat, since none of them typed it.
   * "telegram": the user typing on Telegram — their own message, so it answers a waiting card
   * as a typed message does, but no PPM screen typed it, so none stays the chatting device.
   * "watch": the server reporting on a watched chat — never the user, so it is refused while a
   * card waits or a turn runs rather than cancelling or steering it, and it leaves no chatting
   * device either.
   */
  origin: ChatMessageOrigin;
  sender?: ChatWsSocket;
  /** The channel the user typed on, when it is not a PPM screen. */
  channel?: "telegram";
  images?: Array<{ data: string; mediaType: string }>;
  imagePaths?: string[];
  replyTo?: ReplyReference;
  priority?: "now" | "next" | "later";
  uiSummary?: UiSummary;
  /** The mode a turn this message starts runs in; the chat's sticky mode when absent. */
  permissionMode?: string;
  receivedAt?: number;
}

/**
 * A user's message, from the point it is valid and its sticky settings are stored: rewritten
 * to what will actually run, echoed to the session's other devices, then started as a turn or
 * pushed into the running one.
 */
async function deliverUserMessage(sessionId: string, entry: SessionEntry, text: string, opts: DeliverOpts): Promise<DeliverResult> {
  const providerId = entry.providerId;
  const parsed = { content: text };
  const fromAssistant = opts.origin === "assistant";
  // Only the user's own messages (typed in PPM or on Telegram) may push a waiting card aside.
  const fromUser = opts.origin === "ws" || opts.origin === "telegram";
  // Checked before anything is echoed: the Assistant's message must not answer a card for the
  // user, and a card is how that chat asks them anything.
  if (fromAssistant && entry.pendingApprovalEvent) return { ok: false, error: TARGET_HAS_PENDING_APPROVAL };
  // A watch report waits for a quiet chat: pushed into a running turn it would steer the user's
  // work mid-way, and with a card waiting it would cancel the card.
  if (opts.origin === "watch" && (entry.pendingApprovalEvent || entry.phase !== "idle")) return { ok: false, error: CHAT_BUSY };

  // Kits that self-namespace their skills (AgentKit's `/ak:debug`) publish a
  // name the runtime never registers — it names plugin items after the plugin
  // and directory instead. Rewrite before the echo so every consumer (other
  // devices, the stored transcript, the SDK) sees the name that actually ran.
  const typedContent = parsed.content.trimStart();
  if (typedContent.startsWith("/")) {
    const { listSlashItems, rewriteSlashAlias } = await import("../../services/slash-discovery/index.ts");
    const canonical = rewriteSlashAlias(typedContent, listSlashItems(entry.projectPath ?? ""));
    if (canonical !== typedContent) parsed.content = canonical;
  }

  // Providers with their own skill runtime may not use a leading slash.
  // Codex resolves a skill from a `$name` mention in the prompt; sent as
  // `/imagegen` it is inert prose, so the picked skill would silently not
  // run. Rewritten before the echo for the same reason as the alias above:
  // other devices and the stored transcript must show what actually ran.
  await rewriteProviderSkillSigil(parsed, providerId, sessionId);
  parsed.content = encodeReply(parsed.content, opts.replyTo);

  // Echo the user message to the clients that did not type it (a second device or tab).
  // The sender renders it optimistically; without this echo a live-connected
  // second device only sees the assistant stream for this turn.
  if (entry.clients.size > (opts.sender ? 1 : 0)) {
    const echo = JSON.stringify({
      type: "user_message",
      content: parsed.content,
      imageCount: opts.images?.length ?? 0,
      timestamp: new Date().toISOString(),
    });
    for (const client of entry.clients) {
      if (client === opts.sender) continue;
      try { client.send(echo); } catch { evictClient(entry, client); }
    }
  }
  // Server-side listeners hear every message, including the one a device typed: the echo above
  // reaches only other browsers.
  chatLifecycle.emit("user_message", {
    sessionId, text: parsed.content, origin: opts.origin, imageCount: opts.images?.length ?? 0,
    projectName: entry.projectName ?? "", providerId,
  });

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
        // A listener waiting on the message's turn gets its end, though no provider turn ran.
        emitTurnEnded(sessionId, entry, "done", { finalText: response.slice(0, FINAL_TEXT_KEEP) });
        return { ok: true, sessionId };
      }
    }
  }

  const provider = providerRegistry.get(providerId);

  // User sent a message instead of answering a pending question/approval.
  // The SDK generator is blocked inside canUseTool awaiting that approval, so
  // it can't consume the pushed message — resolve the approval as skipped to
  // unblock it, then the follow-up message flows through normally.
  // Every waiting card goes, the queued ones too: a provider still blocked on a second
  // request could not take the message either, and an Assistant endpoint request ends
  // with "not run" so its agent reads the new message instead of waiting on the card.
  if (fromUser) approvals.clearAll(sessionId, entry, APPROVAL_END.superseded, { deny: true, announce: true });

  // Store user message for reconnect replay (turn_events includes only assistant events)
  entry.currentUserMessage = parsed.content;
  if (opts.sender) {
    entry.lastSender = opts.sender;
    // A tab that sends no id (an older bundle) must not inherit the previous sender's.
    entry.lastSenderClientId = opts.sender.data.clientId;
  } else if (opts.origin === "telegram" || opts.origin === "watch") {
    // The user is not at any PPM screen for this turn: the UI tools must answer "no device"
    // rather than drive the screen the user last typed on, which may be in another room.
    entry.lastSender = undefined;
    entry.lastSenderClientId = undefined;
  }
  // What this device shows, for an Assistant session's turn. Validated and cleaned by
  // chatService, which ignores it for every other session; only an object is passed on.
  const rawSummary = opts.uiSummary as unknown;
  const uiSummary = rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary) ? rawSummary as UiSummary : undefined;
  // Only a message that opens a turn is timed; one typed mid-turn joins the running turn.
  if (!entry.isStreamingActive || entry.phase === "idle") {
    entry.turnRequestedAt = { at: opts.receivedAt ?? Date.now(), cold: !entry.isStreamingActive };
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
        return { ok: false, error: `The chat could not be resumed: ${(e as Error).message}` };
      }
      const elapsed = Date.now() - t0;
      if (elapsed > 500) {
        log.warn(`session=${sessionId} resumeSession took ${elapsed}ms`);
        logSessionEvent(sessionId, "PERF", `resumeSession took ${elapsed}ms`);
      }
    }
    if (entry.projectPath && provider && "ensureProjectPath" in provider) {
      (provider as any).ensureProjectPath(sessionId, entry.projectPath);
    }

    entry.turnEvents = [];
    setPhase(sessionId, "initializing");

    const permMode = opts.permissionMode ?? entry.permissionMode;
    const msgModel = entry.model;
    entry.streamPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        startSessionConsumer(sessionId, providerId, parsed.content, permMode, opts.images, msgModel, opts.imagePaths, uiSummary, opts.origin, opts.channel).then(resolve, resolve);
      }, 0);
    });
  } else {
    // Follow-up: push into existing generator via provider
    if (provider && "pushMessage" in provider) {
      const effort = getSessionEffort(sessionId) ?? undefined;
      const thinkingBudget = getSessionThinking(sessionId);
      try {
        await chatService.pushMessage(providerId, sessionId, parsed.content, {
          origin: opts.origin,
          ...(opts.channel ? { channel: opts.channel } : {}),
          priority: opts.priority ?? "next",
          images: opts.images,
          imagePaths: opts.imagePaths,
          ...(entry.model ? { model: entry.model } : {}),
          ...(effort ? { effort } : {}),
          ...(thinkingBudget != null ? { thinkingBudget } : {}),
          ...(uiSummary ? { uiSummary } : {}),
        });
      } catch (e) {
        log.error(`session=${sessionId} follow-up failed provider=${providerId}:`, e);
        return { ok: false, error: `The message could not be passed to the running chat: ${(e as Error).message}` };
      }
    }
    // Clear turn events for new turn display + transition phase. Waiting cards were cleared
    // before the push; one that arrived since belongs to this message and stays.
    entry.turnEvents = [];
    setPhase(sessionId, "thinking");
    log.debug(`session=${sessionId} follow-up pushed to generator`);
  }
  return { ok: true, sessionId };
}

const MAX_MESSAGE_IMAGES = 5;
const MAX_IMAGE_BASE64_SIZE = 7_000_000; // ~5MB decoded
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Why a message's images cannot be sent, or null when they can (or there are none). */
function messageImagesError(images: unknown): string | null {
  if (images == null) return null;
  if (!Array.isArray(images)) return "Images must be a list";
  if (images.length === 0) return null;
  if (images.length > MAX_MESSAGE_IMAGES) return `Max ${MAX_MESSAGE_IMAGES} images per message`;
  for (const img of images as Array<{ data?: unknown; mediaType?: unknown }>) {
    if (!img || typeof img.data !== "string" || typeof img.mediaType !== "string") return "Malformed image";
    if (img.data.length > MAX_IMAGE_BASE64_SIZE) return "Image too large (max 5MB)";
    if (!SUPPORTED_IMAGE_TYPES.has(img.mediaType)) return `Unsupported image type: ${img.mediaType}`;
  }
  return null;
}

/** A session's entry before any turn: idle, nothing buffered. */
function newSessionEntry(
  sessionId: string,
  init: { providerId: string; clients: ChatWsSocket[]; projectPath?: string; projectName?: string },
): SessionEntry {
  return {
    providerId: init.providerId,
    clients: new Set(init.clients),
    projectPath: init.projectPath,
    projectName: init.projectName,
    pingIntervals: new Map(),
    phase: "idle",
    turnEvents: [],
    isStreamingActive: false,
    streamSeq: 0,
    teamWatchers: new Map(),
    teamNames: new Set(),
    compactStatus: null,
    model: getSessionModel(sessionId) ?? undefined,
  };
}

/** What the PPM Assistant's `chat_send_message` needs to know about its target before asking. */
function assistantTargetState(sessionId: string, providerId: string): ChatDeliveryState {
  const entry = activeSessions.get(resolveMigratedSession(sessionId));
  return {
    providerId: entry?.providerId ?? providerId,
    running: !!entry?.isStreamingActive,
    ...(entry?.liveMode ? { liveMode: entry.liveMode } : {}),
    ...(entry?.permissionMode ? { entryMode: entry.permissionMode } : {}),
    pendingApproval: !!entry?.pendingApprovalEvent,
  };
}

/**
 * The live entry of a chat the server acts on with no socket attached (a message from the PPM
 * Assistant, from Telegram, from a watch). A chat nobody has open gets an entry of its own, so
 * whoever opens it later sees the turn; nobody may ever open it, so it is marked idle and goes
 * like any abandoned entry once its turn is over. `sessionId` must already be the current id.
 */
function ensureServerEntry(
  sessionId: string,
  projectName: string,
  providerId: string,
): { ok: true; entry: SessionEntry } | { ok: false; error: string } {
  const existing = activeSessions.get(sessionId);
  if (existing) return { ok: true, entry: existing };
  let projectPath: string | undefined;
  try { projectPath = resolveChatProjectPath(projectName); } catch {
    return { ok: false, error: `Project "${projectName}" is not registered any more.` };
  }
  const entry = newSessionEntry(sessionId, {
    providerId: resolveStoredProvider(sessionId) ?? providerId, clients: [], projectPath, projectName,
  });
  activeSessions.set(sessionId, entry);
  entry.idleSince = Date.now();
  return { ok: true, entry };
}

/**
 * A message the PPM Assistant sends into one of the user's chats, once the user approved it
 * (`chat_send_message`). Runs in `permissionMode`, the mode the card showed: if the chat would
 * now run it in another one — its session started meanwhile in a different mode — nothing is
 * sent. A chat nobody has open gets an entry of its own, so whoever opens it later sees the turn.
 */
async function deliverFromAssistant(
  target: { sessionId: string; projectName: string; providerId: string },
  text: string,
  permissionMode: string,
): Promise<DeliverResult> {
  const sessionId = resolveMigratedSession(target.sessionId);
  if (isAssistantSession(sessionId)) return { ok: false, error: "The Assistant cannot send messages into its own chats." };
  const ensured = ensureServerEntry(sessionId, target.projectName, target.providerId);
  if (!ensured.ok) return ensured;
  const { entry } = ensured;
  const now = targetChatMode(sessionId, assistantTargetState(sessionId, entry.providerId));
  if (now.mode !== permissionMode) {
    return { ok: false, error: `The chat would now run in "${now.mode}" rather than "${permissionMode}", the mode the user approved; nothing was sent. Ask again.` };
  }
  logSessionEvent(sessionId, "INFO", `Message from the PPM Assistant, approved by the user (mode ${permissionMode})`);
  const result = await deliverUserMessage(sessionId, entry, text, { origin: "assistant", permissionMode });
  // An entry made for this message and left unused must not outlive the attempt.
  if (!result.ok && entry.clients.size === 0 && !entry.isStreamingActive) startCleanupTimer(sessionId);
  return result;
}

setAssistantChatDelivery({
  inspect: (sessionId, providerId) => {
    const state = assistantTargetState(sessionId, providerId);
    return { ...targetChatMode(resolveMigratedSession(sessionId), state), pendingApproval: state.pendingApproval };
  },
  deliver: deliverFromAssistant,
});

/**
 * Answers a session's approval card — from a browser, or from the server on a person's behalf
 * (a Telegram button). The one way a card is answered, so whichever answer arrives first wins and
 * the other finds nothing waiting. "stale": nothing waits on that id any more — answered
 * elsewhere, ended, or from before a restart; the caller says so rather than broadcasting a
 * resolution, which would make a stale card look as if the user's answer ran something.
 */
function answerApprovalCore(
  sessionId: string,
  entry: SessionEntry,
  requestId: string,
  approved: boolean,
  data: unknown,
  origin: ChatMessageOrigin,
): "answered" | "stale" {
  // Answered: the buffered request carries the answer, so a replay renders it answered
  // (an AskUserQuestion card shows its chosen answers).
  const recordAnswer = () => {
    for (let i = entry.turnEvents.length - 1; i >= 0; i--) {
      const buffered = entry.turnEvents[i] as any;
      if (buffered.type === "approval_request" && buffered.requestId === requestId) {
        buffered.approved = approved;
        if (buffered.tool === "AskUserQuestion" && data) buffered.input = { ...buffered.input, answers: data };
        break;
      }
    }
  };
  // Whoever settles the card is named on the `approval_resolved` it leaves with. Clearing is
  // synchronous — the broker's end callback included — so the name cannot leak to another card.
  const previous = resolvingBy;
  resolvingBy = origin;
  try {
    // The Assistant endpoint's own request: the first device to answer settles it, and the
    // broker's end takes the card away on every device (see setAssistantApprovalDelivery).
    if (assistantApprovalBroker.owns(requestId) && assistantApprovalBroker.settle(sessionId, requestId, approved)) {
      recordAnswer();
      return "answered";
    }
    if (!approvals.has(entry, requestId)) {
      logSessionEvent(sessionId, "INFO", `approval_response${origin === "ws" ? "" : ` (${origin})`} for unknown request ${requestId.slice(0, 64)} refused as no longer valid`);
      return "stale";
    }
    chatService.resolveApproval(entry.providerId, sessionId, requestId, approved, data, { origin });
    recordAnswer();
    // Tell every connected device this approval was resolved so their live prompt clears —
    // even the device that didn't answer — and show the next card waiting, if any.
    approvals.clear(sessionId, entry, requestId, APPROVAL_END.answered, { announce: true, approved, answers: data ?? null });
    broadcast(sessionId, { type: "phase_changed", phase: entry.phase });
    return "answered";
  } finally {
    resolvingBy = previous;
  }
}

/** Stops a session's running turn: its subprocess is torn down, so the next message resumes. */
function cancelTurnCore(sessionId: string, entry: SessionEntry, origin: ChatMessageOrigin): void {
  const phase = entry.phase ?? "unknown";
  const who = origin === "ws" ? "FE" : origin;
  log.info(`session=${sessionId} ${origin === "ws" ? "WS" : origin} cancel received from ${who} (phase=${phase})`);
  logSessionEvent(sessionId, "CANCEL", `${origin === "ws" ? "WS" : origin} cancel from ${who} (phase=${phase})`);
  // An Assistant endpoint request is withdrawn here rather than left to the provider closing
  // its HTTP call: the card goes at once and its tool answers "not run".
  approvals.clearAll(sessionId, entry, APPROVAL_END.cancelled, { only: "endpoint" });
  chatService.abortQuery(entry.providerId, sessionId, `${origin}_cancel`, origin);
}

function liveChatState(entry: SessionEntry): LiveChatState {
  return {
    phase: entry.phase,
    running: entry.phase !== "idle",
    projectName: entry.projectName ?? "",
    providerId: entry.providerId,
    ...(entry.pendingApprovalEvent ? { card: liveApprovalCard(entry.pendingApprovalEvent) } : {}),
    queuedCards: entry.approvalQueue?.length ?? 0,
  };
}

const SERVER_ORIGINS: readonly ServerOrigin[] = ["telegram", "watch", "assistant"];

setChatControl({
  async sendUserMessage(asked, text, opts) {
    // Checked here as well as by the types: this is the boundary every server-side sender crosses.
    if (!SERVER_ORIGINS.includes(opts.origin)) return { ok: false, error: `Unknown message origin "${String(opts.origin)}".` };
    if (typeof text !== "string" || (!text.trim() && !opts.images?.length)) return { ok: false, error: "Message content is required" };
    const imageError = messageImagesError(opts.images);
    if (imageError) return { ok: false, error: imageError };
    if (opts.permissionMode && !VALID_PERMISSION_MODES.includes(opts.permissionMode as typeof VALID_PERMISSION_MODES[number])) {
      return { ok: false, error: `Unknown permission mode "${opts.permissionMode}".` };
    }
    const sessionId = resolveMigratedSession(asked);
    const ensured = ensureServerEntry(sessionId, opts.projectName, opts.providerId);
    if (!ensured.ok) return ensured;
    const { entry } = ensured;
    const result = await deliverUserMessage(sessionId, entry, text, {
      origin: opts.origin,
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      receivedAt: Date.now(),
    });
    // Nobody is watching: the entry goes once it is idle (a running turn re-arms this when it ends).
    if (entry.clients.size === 0) startCleanupTimer(sessionId);
    return result;
  },
  answerApproval(asked, requestId, answer, origin) {
    const sessionId = resolveMigratedSession(asked);
    const entry = activeSessions.get(sessionId);
    if (!entry || typeof requestId !== "string" || !requestId) return "stale";
    return answerApprovalCore(sessionId, entry, requestId, answer.approved === true, answer.answers, origin);
  },
  cancelTurn(asked, origin) {
    const sessionId = resolveMigratedSession(asked);
    const entry = activeSessions.get(sessionId);
    if (!entry) return false;
    cancelTurnCore(sessionId, entry, origin);
    return true;
  },
  liveState(asked) {
    const entry = activeSessions.get(resolveMigratedSession(asked));
    return entry ? liveChatState(entry) : null;
  },
  listLive() {
    return [...activeSessions].map(([sessionId, entry]) => ({ sessionId, ...liveChatState(entry) }));
  },
});

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
      try { projectPath = resolveChatProjectPath(projectName); } catch { reportUnregisteredProject(sessionId, projectName); }
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
        sessionTitle: session?.title || null,
        compactStatus: existing.compactStatus ?? null,
        mcpNeedsAuth: existing.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        thinking: resolveSessionThinkingEnabled(sessionId),
        promptCache: promptCacheSnapshot(sessionId, existing),
        turnStop: existing.phase === "idle" ? lastTurnStop(sessionId) : null,
      }));

      // If actively streaming, send buffered turn events for reconnect sync
      if (existing.phase !== "idle") {
        sendTurnEvents(sessionId, ws);
      }

      // NOW add to clients Set + set up ping
      existing.clients.add(ws);
      setupClientPing(existing, ws);

      // A team created in an earlier turn (or before a server restart) leaves no
      // live event to replay — re-attach from disk so the UI comes back.
      void detectImplicitTeam(sessionId);

      // Async: resolve title from SDK if in-memory title is generic (DB title takes priority)
      if (!session?.title || session.title === "Chat" || session.title === "Resumed Chat") {
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
      log.debug(`session=${sessionId} FE reconnected (phase=${existing.phase}, clients=${existing.clients.size})`);
      return;
    }

    // New session entry
    const newEntry = newSessionEntry(sessionId, { providerId, clients: [ws], projectPath, projectName });
    activeSessions.set(sessionId, newEntry);
    setupClientPing(newEntry, ws);

    // Resuming a session whose team already exists on disk (server restart, or a
    // team created many turns ago) — re-attach the watcher.
    void detectImplicitTeam(sessionId);

    ws.send(JSON.stringify({
      type: "session_state",
      sessionId,
      phase: "idle",
      pendingApproval: null,
      sessionTitle: session?.title || null,
      compactStatus: null,
      model: resolveSessionModel(sessionId),
      turnStop: lastTurnStop(sessionId),
    }));

    // Async: resolve title from SDK if in-memory title is generic (DB title takes priority)
    if (!session?.title || session.title === "Chat" || session.title === "Resumed Chat") {
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

    // A device answering an AI tab tool (see deliverToChattingDevice). Settles only a call
    // pending for this very session; anything else is dropped without a reply.
    if (parsed.type === "tab_open_result") {
      const result = parseTabOpenResult(parsed);
      if (result) tabOpenBroker.settle(sessionId, result);
      return;
    }
    // The same for the PPM Assistant's UI tools.
    if (parsed.type === "assistant_ui_result") {
      const result = parseAssistantUiResult(parsed);
      if (result) assistantUiBroker.settle(sessionId, result);
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
      if (pn) { try { pp = resolveChatProjectPath(pn); } catch { reportUnregisteredProject(sessionId, pn); } }
      const newEntry = newSessionEntry(sessionId, { providerId: pid, clients: [ws], projectPath: pp, projectName: pn });
      activeSessions.set(sessionId, newEntry);
      setupClientPing(newEntry, ws);
      entry = newEntry;
      log.info(`session=${sessionId} auto-created entry in message handler`);
    }

    // Ensure ws is in clients set
    if (!entry.clients.has(ws)) {
      entry.clients.add(ws);
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
        sessionTitle: chatService.getSession(sessionId)?.title || null,
        compactStatus: entry.compactStatus ?? null,
        mcpNeedsAuth: entry.mcpNeedsAuth ?? [],
        model: resolveSessionModel(sessionId),
        effort: resolveSessionEffort(sessionId),
        thinking: resolveSessionThinkingEnabled(sessionId),
        promptCache: promptCacheSnapshot(sessionId, entry),
        turnStop: entry.phase === "idle" ? lastTurnStop(sessionId) : null,
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
      const imageError = messageImagesError(parsed.images);
      if (imageError) {
        ws.send(JSON.stringify({ type: "error", message: imageError }));
        return;
      }
      // Store permission mode — sticky for this session
      if (parsed.permissionMode) {
        entry.permissionMode = parsed.permissionMode;
        // Every chat keeps the mode the user picked, rather than this socket alone: a design
        // session runs callers that pass none (CLI, scheduler) in it, and a message the PPM
        // Assistant sends into the chat runs in it — the approval card says so.
        if (VALID_PERMISSION_MODES.includes(parsed.permissionMode as typeof VALID_PERMISSION_MODES[number])) {
          try { setSessionPermissionMode(sessionId, parsed.permissionMode); } catch (e) {
            log.warn(`session=${sessionId} could not save permission mode: ${(e as Error).message}`);
          }
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

      await deliverUserMessage(sessionId, entry, parsed.content, {
        origin: "ws",
        sender: ws,
        images: parsed.images,
        imagePaths: parsed.imagePaths,
        replyTo: parsed.replyTo ?? undefined,
        priority: parsed.priority,
        uiSummary: (parsed as { uiSummary?: UiSummary }).uiSummary,
        receivedAt: messageReceivedAt,
      });
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
      const provider = providerRegistry.get(providerId);
      const hasLiveStream = provider?.hasStreamingSession?.(sessionId) ?? false;
      // Only abort when idle between turns — never interrupt an active turn.
      // Aborting the idle-but-alive subprocess forces the next message to take
      // the resume path, recreating the query with the new model.
      if (hasLiveStream && entry.phase === "idle") {
        chatService.abortQuery(providerId, sessionId, "set_model", "ws");
      }
      logSessionEvent(sessionId, "INFO", `Model switched to ${parsed.model}`);
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
      logSessionEvent(sessionId, "INFO", `Effort switched to ${parsed.effort}`);
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
      logSessionEvent(sessionId, "INFO", `Thinking ${parsed.enabled ? "on" : "off"}`);
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
        thinking: resolveSessionThinkingEnabled(sessionId),
      }));
    } else if (parsed.type === "cancel") {
      // Fully teardown streaming session — user must resume to continue
      cancelTurnCore(sessionId, entry, "ws");
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
        // A waiting card stays: the instruction queues behind it, and the card is still answerable.
        entry.turnEvents = [];
        setPhase(sessionId, "thinking");
      }
      logSessionEvent(sessionId, "INFO", `kill_background_shell requested shellId=${shellId}`);
    } else if (parsed.type === "approval_response") {
      const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
      const approved = parsed.approved === true;
      const respData = (parsed as { data?: unknown }).data;
      if (answerApprovalCore(sessionId, entry, requestId, approved, respData, "ws") === "stale") {
        const stale: ApprovalStaleMessage = { type: "approval_stale", requestId, message: APPROVAL_NO_LONGER_VALID_MESSAGE };
        try { ws.send(JSON.stringify(stale)); } catch { /* socket gone */ }
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
