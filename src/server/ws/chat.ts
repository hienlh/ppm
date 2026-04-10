import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { logSessionEvent } from "../../services/session-log.service.ts";
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import { getSessionTitle } from "../../services/db.service.ts";
import type { ChatWsClientMessage, SessionPhase } from "../../types/api.ts";

const PING_INTERVAL_MS = 15_000; // 15s keepalive
const CLEANUP_TIMEOUT_MS = 5 * 60_000; // 5min after Claude done + no FE
const MAX_TURN_EVENTS = 10_000; // memory safety cap
const BUFFERABLE_TYPES = new Set([
  "text", "thinking", "tool_use", "tool_result",
  "approval_request", "error", "done", "account_info", "account_retry",
  "team_detected",
]);

type ChatWsSocket = {
  data: { type: string; sessionId: string; projectName?: string };
  send: (data: string) => void;
  ping?: (data?: string | ArrayBuffer) => void;
};

interface SessionEntry {
  providerId: string;
  clients: Set<ChatWsSocket>;
  projectPath?: string;
  projectName?: string;
  pingIntervals: Map<ChatWsSocket, ReturnType<typeof setInterval>>;
  phase: SessionPhase;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  pendingApprovalEvent?: { type: string; requestId: string; tool: string; input: unknown };
  turnEvents: unknown[];
  streamPromise?: Promise<void>;
  permissionMode?: string;
  /** Whether the persistent event consumer loop is running */
  isStreamingActive: boolean;
  /** Active team watchers keyed by team name */
  teamWatchers: Map<string, { cleanup: () => void }>;
  /** Set of detected team names for this session */
  teamNames: Set<string>;
  /** toolUseId of a pending TeamCreate call */
  pendingTeamCreate?: string;
}

/** Tracks active sessions — persists even when FE disconnects */
const activeSessions = new Map<string, SessionEntry>();

/** Check if any frontend client is currently connected via WebSocket */
export function hasActiveClient(): boolean {
  for (const entry of activeSessions.values()) {
    if (entry.clients.size > 0) return true;
  }
  return false;
}

/** Remove a client from the session, cleaning up its ping interval */
function evictClient(entry: SessionEntry, ws: ChatWsSocket): void {
  clearClientPing(entry, ws);
  entry.clients.delete(ws);
}

/** Broadcast event to all connected clients for a session */
function broadcast(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.clients.size === 0) {
    const evType = (event as any)?.type ?? "unknown";
    if (evType !== "ping" && evType !== "phase_changed") {
      console.warn(`[chat] session=${sessionId} broadcast: no clients, dropping ${evType}`);
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
  if (evType && BUFFERABLE_TYPES.has(evType)) {
    if (entry.turnEvents.length < MAX_TURN_EVENTS) {
      entry.turnEvents.push({ ...(event as Record<string, unknown>) });
    }
  }
  broadcast(sessionId, event);
}

/** Transition session phase — guards same-phase, broadcasts phase_changed */
function setPhase(sessionId: string, phase: SessionPhase, elapsed?: number): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.phase === phase) return;
  entry.phase = phase;
  broadcast(sessionId, { type: "phase_changed", phase, ...(elapsed != null ? { elapsed } : {}) });
  console.log(`[chat] session=${sessionId} phase → ${phase}`);
}

/** Send buffered turn events to a single client (reconnect sync) */
function sendTurnEvents(sessionId: string, ws: ChatWsSocket): void {
  const entry = activeSessions.get(sessionId);
  if (!entry || entry.turnEvents.length === 0) return;
  try {
    ws.send(JSON.stringify({ type: "turn_events", events: entry.turnEvents }));
  } catch (e) {
    console.warn(`[chat] session=${sessionId} sendTurnEvents failed: ${(e as Error).message}`);
  }
}

/** Set up per-client application-level ping */
function setupClientPing(entry: SessionEntry, ws: ChatWsSocket): void {
  const interval = setInterval(() => {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ws may be closed */ }
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
    console.log(`[chat] session=${sessionId} cleanup: idle with no FE for ${CLEANUP_TIMEOUT_MS / 1000}s`);
    logSessionEvent(sessionId, "INFO", "Session cleaned up (idle, no FE reconnected)");
    for (const interval of entry.pingIntervals.values()) clearInterval(interval);
    entry.pingIntervals.clear();
    for (const w of entry.teamWatchers.values()) w.cleanup();
    entry.teamWatchers.clear();
    activeSessions.delete(sessionId);
  }, CLEANUP_TIMEOUT_MS);
}

/**
 * Persistent event consumer — runs for the entire session lifetime.
 * First message creates the query; follow-ups push into the provider's
 * message channel. Events from ALL turns flow through this single loop.
 */
async function startSessionConsumer(sessionId: string, providerId: string, content: string, permissionMode?: string, images?: Array<{ data: string; mediaType: string }>): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    console.error(`[chat] session=${sessionId} startSessionConsumer: no entry — aborting`);
    return;
  }
  console.log(`[chat] session=${sessionId} startSessionConsumer started (clients=${entry.clients.size})`);

  entry.isStreamingActive = true;
  entry.pendingApprovalEvent = undefined;
  entry.turnEvents = [];
  setPhase(sessionId, "connecting");

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastContextWindowPct: number | undefined;

  try {
    const userPreview = content.slice(0, 200);
    logSessionEvent(sessionId, "USER", userPreview);
    console.log(`[chat] session=${sessionId} sending message to provider=${providerId}`);

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
        console.error(`[chat] session=${sessionId} SDK connection timeout after ${elapsed}s`);
        logSessionEvent(sessionId, "ERROR", `SDK connection timeout after ${elapsed}s — subprocess may have failed to start`);
        const projectPath = entry?.projectPath ?? "";
        const isWSL = projectPath.startsWith("/home/") || projectPath.startsWith("/mnt/");
        const wslHint = isWSL
          ? "\n\nWSL detected — this is likely a network issue. Try from your WSL terminal:\n  curl -s https://api.anthropic.com\nIf that fails, check WSL DNS settings (/etc/resolv.conf) or proxy configuration."
          : "";
        const debugCmd = projectPath ? `cd ${projectPath} && claude -p "hi"` : `claude -p "hi"`;
        bufferAndBroadcast(sessionId, {
          type: "error",
          message: `Claude SDK timed out after ${elapsed}s for project "${projectPath || "(no project)"}".${wslHint}\n\nDebug steps:\n1. Run: \`${debugCmd}\` — if it also hangs, the issue is your Claude CLI environment\n2. Check env vars: \`echo $ANTHROPIC_API_KEY $ANTHROPIC_BASE_URL\` — stale/invalid keys cause silent hang\n3. Try with env cleared: \`ANTHROPIC_API_KEY="" ANTHROPIC_BASE_URL="" ${debugCmd}\`\n4. Check hooks/MCP: \`cat ${projectPath}/.claude/settings.local.json\`\n5. Refresh auth: \`claude login\``,
        });
        return;
      }
      broadcast(sessionId, { type: "phase_changed", phase: "connecting", elapsed });
    }, 5_000);

    for await (const event of chatService.sendMessage(providerId, sessionId, content, { permissionMode, images })) {
      eventCount++;
      const ev = event as any;
      const evType = ev.type ?? "unknown";

      // System events → transition connecting → thinking, forward compact events
      if (evType === "system") {
        const sub = (ev as any).subtype;
        if (sub === "compacting") {
          broadcast(sessionId, { type: "compact_status", status: "compacting" });
        } else if (sub === "compact_done") {
          broadcast(sessionId, { type: "compact_status", status: "done" });
        }
        if (!firstEventReceived) {
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
        const waitMs = Date.now() - startTime;
        console.log(`[chat] session=${sessionId} first SDK event after ${waitMs}ms: type=${evType}`);
        logSessionEvent(sessionId, "PERF", `First SDK event after ${waitMs}ms (type=${evType})`);
        if (heartbeat) clearInterval(heartbeat);
        const newPhase = evType === "thinking" ? "thinking" : "streaming";
        setPhase(sessionId, newPhase);
      }

      // Dynamic phase transitions between thinking/streaming
      if (firstEventReceived) {
        if (evType === "text" && entry.phase === "thinking") setPhase(sessionId, "streaming");
        if (evType === "thinking" && entry.phase === "streaming") setPhase(sessionId, "thinking");
      }

      // Log every event
      if (evType === "text") {
        logSessionEvent(sessionId, "TEXT", ev.content?.slice(0, 500) ?? "");
      } else if (evType === "tool_use") {
        logSessionEvent(sessionId, "TOOL_USE", `${ev.tool} ${JSON.stringify(ev.input).slice(0, 300)}`);
        // Track TeamCreate calls for team detection
        if (ev.tool === "TeamCreate") {
          entry.pendingTeamCreate = ev.toolUseId;
          console.log(`[chat] session=${sessionId} TeamCreate tool_use detected, toolUseId=${ev.toolUseId}`);
        }
      } else if (evType === "tool_result") {
        logSessionEvent(sessionId, "TOOL_RESULT", `error=${ev.isError ?? false} ${(ev.output ?? "").slice(0, 300)}`);
        console.log(`[chat] session=${sessionId} tool_result: toolUseId=${ev.toolUseId} pendingTeamCreate=${entry.pendingTeamCreate} output=${(ev.output ?? "").slice(0, 200)}`);
        // Detect team creation from TeamCreate tool_result
        if (entry.pendingTeamCreate && entry.pendingTeamCreate === ev.toolUseId) {
          const { extractTeamName, startTeamInboxWatcher } = await import("./team-inbox-watcher.ts");
          const teamName = extractTeamName(ev.output ?? "");
          console.log(`[chat] session=${sessionId} TeamCreate result matched, extracted teamName=${teamName}`);
          if (teamName && !entry.teamNames.has(teamName)) {
            entry.teamNames.add(teamName);
            const watcher = startTeamInboxWatcher(teamName, {
              onInboxUpdate: (tn, agent, msgs) => broadcast(sessionId, {
                type: "team_inbox", teamName: tn, agent, messages: msgs,
              }),
              onConfigUpdate: (tn, config) => broadcast(sessionId, {
                type: "team_updated", teamName: tn, team: config,
              }),
            });
            entry.teamWatchers.set(teamName, watcher);
            bufferAndBroadcast(sessionId, { type: "team_detected", teamName });
            console.log(`[chat] session=${sessionId} team detected: ${teamName}`);
          }
          entry.pendingTeamCreate = undefined;
        }
      } else if (evType === "error") {
        const errorDetail = ev.message ?? JSON.stringify(ev).slice(0, 500);
        console.error(`[chat] session=${sessionId} error: ${errorDetail}`);
        logSessionEvent(sessionId, "ERROR", errorDetail);
      } else if (evType === "done") {
        // Turn complete — transition to idle, clear buffer for next turn
        logSessionEvent(sessionId, "DONE", `subtype=${ev.resultSubtype ?? "none"} turns=${ev.numTurns ?? "?"} ctx=${ev.contextWindowPct ?? "?"}%`);
        if (ev.contextWindowPct != null) lastContextWindowPct = ev.contextWindowPct;

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
        import("../../services/notification.service.ts").then(({ notificationService }) => {
          const project = entry.projectName || "Project";
          const session = chatService.getSession(sessionId);
          const sessionTitle = session?.title || `Session ${sessionId.slice(0, 8)}`;
          notificationService.broadcast("done", {
            title: "Chat completed",
            body: `${project} — ${sessionTitle}`,
            project,
            sessionId,
            sessionTitle,
          });
        }).catch(() => {});
      } else if (evType === "approval_request") {
        entry.pendingApprovalEvent = ev;
        import("../../services/notification.service.ts").then(({ notificationService }) => {
          const project = entry.projectName || "Project";
          const session = chatService.getSession(sessionId);
          const sTitle = session?.title || `Session ${sessionId.slice(0, 8)}`;
          const isQuestion = ev.tool === "AskUserQuestion";
          const nType = isQuestion ? "question" : "approval_request";
          const title = isQuestion ? "AI has a question" : "Waiting for approval";
          const body = isQuestion
            ? `${project} — ${sTitle}`
            : `${project} — ${ev.tool} needs permission`;
          notificationService.broadcast(nType as any, { title, body, project, sessionId, sessionTitle: sTitle, tool: ev.tool });
        }).catch(() => {});
      } else if (evType === "session_migrated") {
        // CLI providers discover real session ID from CLI output — migrate WS tracking
        const newId = ev.newSessionId as string;
        if (newId && newId !== sessionId) {
          console.log(`[chat] session_migrated: ${sessionId} → ${newId}`);
          const oldEntry = activeSessions.get(sessionId);
          if (oldEntry) {
            activeSessions.delete(sessionId);
            activeSessions.set(newId, oldEntry);
          }
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
        entry.pendingApprovalEvent = undefined;
        setPhase(sessionId, "idle");
        // Reset heartbeat tracking for next turn
        firstEventReceived = false;
        startTime = Date.now();
      }
    }

    logSessionEvent(sessionId, "INFO", `Session consumer completed (${eventCount} events total)`);
    console.log(`[chat] session=${sessionId} session consumer completed (${eventCount} events)`);
  } catch (e) {
    const errMsg = (e as Error).message;
    logSessionEvent(sessionId, "ERROR", `Exception: ${errMsg}`);
    bufferAndBroadcast(sessionId, { type: "error", message: errMsg });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    entry.isStreamingActive = false;
    entry.turnEvents = [];
    setPhase(sessionId, "idle");
    entry.pendingApprovalEvent = undefined;
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
    console.log(`[chat] session=${sessionId} consumer loop ended`);
  }
}

/**
 * Chat WebSocket handler for Bun.serve().
 *
 * Session lifecycle: BE owns Claude connection. FE disconnect does NOT abort Claude.
 * Streaming runs in standalone async function, not tied to WS message handler.
 */
export const chatWebSocket = {
  open(ws: ChatWsSocket) {
    const { sessionId, projectName } = ws.data;
    const session = chatService.getSession(sessionId);
    const providerId = session?.providerId ?? providerRegistry.getDefault().id;

    let projectPath: string | undefined;
    if (projectName) {
      try { projectPath = resolveProjectPath(projectName); } catch { /* ignore */ }
    }
    if (session && !session.projectPath && projectPath) {
      session.projectPath = projectPath;
    }

    const existing = activeSessions.get(sessionId);
    if (existing) {
      // FE reconnecting to existing session — clear cleanup timer
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
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
      }));

      // If actively streaming, send buffered turn events for reconnect sync
      if (existing.phase !== "idle") {
        sendTurnEvents(sessionId, ws);
      }

      // NOW add to clients Set + set up ping
      existing.clients.add(ws);
      setupClientPing(existing, ws);

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
      console.log(`[chat] session=${sessionId} FE reconnected (phase=${existing.phase}, clients=${existing.clients.size})`);
      return;
    }

    // New session entry
    const newEntry: SessionEntry = {
      providerId,
      clients: new Set([ws]),
      projectPath,
      projectName,
      pingIntervals: new Map(),
      phase: "idle",
      turnEvents: [],
      isStreamingActive: false,
      teamWatchers: new Map(),
      teamNames: new Set(),
    };
    activeSessions.set(sessionId, newEntry);
    setupClientPing(newEntry, ws);

    ws.send(JSON.stringify({
      type: "session_state",
      sessionId,
      phase: "idle",
      pendingApproval: null,
      sessionTitle: session?.title || null,
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

    let entry = activeSessions.get(sessionId);

    // Auto-create entry if missing — handles: message before open (Bun race), or session cleaned up
    if (!entry) {
      const { projectName: pn } = ws.data;
      const session = chatService.getSession(sessionId);
      const pid = session?.providerId ?? providerRegistry.getDefault().id;
      let pp: string | undefined;
      if (pn) { try { pp = resolveProjectPath(pn); } catch { /* ignore */ } }
      const newEntry: SessionEntry = {
        providerId: pid, clients: new Set([ws]), projectPath: pp, projectName: pn,
        pingIntervals: new Map(), phase: "idle", turnEvents: [], isStreamingActive: false,
        teamWatchers: new Map(), teamNames: new Set(),
      };
      activeSessions.set(sessionId, newEntry);
      setupClientPing(newEntry, ws);
      entry = newEntry;
      console.log(`[chat] session=${sessionId} auto-created entry in message handler`);
    }

    // Ensure ws is in clients set
    if (!entry.clients.has(ws)) {
      entry.clients.add(ws);
    }

    const providerId = entry.providerId ?? providerRegistry.getDefault().id;

    // Client-initiated handshake — FE sends "ready" after onopen.
    // Re-send status so tunnel connections (Cloudflare) that missed the
    // open-handler message still get connected/status confirmation.
    if (parsed.type === "ready") {
      ws.send(JSON.stringify({
        type: "session_state",
        sessionId,
        phase: entry.phase,
        pendingApproval: entry.pendingApprovalEvent ?? null,
        sessionTitle: chatService.getSession(sessionId)?.title || null,
      }));
      if (entry.phase !== "idle") {
        sendTurnEvents(sessionId, ws);
      }
      return;
    }

    if (parsed.type === "message") {
      if (typeof parsed.content !== "string" || !parsed.content.trim()) {
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
      // Store permission mode — sticky for this session
      if (parsed.permissionMode) {
        entry.permissionMode = parsed.permissionMode;
      }

      const provider = providerRegistry.get(providerId);

      if (!entry.isStreamingActive) {
        // First message or post-crash recovery: start persistent consumer
        // Resume session in provider (can be slow on first call — sdkListSessions)
        if (provider && "resumeSession" in provider) {
          const t0 = Date.now();
          await (provider as any).resumeSession(sessionId);
          const elapsed = Date.now() - t0;
          if (elapsed > 500) {
            console.warn(`[chat] session=${sessionId} resumeSession took ${elapsed}ms`);
            logSessionEvent(sessionId, "PERF", `resumeSession took ${elapsed}ms`);
          }
        }
        if (entry.projectPath && provider && "ensureProjectPath" in provider) {
          (provider as any).ensureProjectPath(sessionId, entry.projectPath);
        }

        entry.turnEvents = [];
        setPhase(sessionId, "initializing");

        const permMode = entry.permissionMode;
        const msgImages = parsed.type === "message" ? parsed.images : undefined;
        entry.streamPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            startSessionConsumer(sessionId, providerId, parsed.content, permMode, msgImages).then(resolve, resolve);
          }, 0);
        });
      } else {
        // Follow-up: push into existing generator via provider
        if (provider && "pushMessage" in provider && parsed.type === "message") {
          (provider as any).pushMessage(sessionId, parsed.content, {
            priority: parsed.priority ?? 'next',
            images: parsed.images,
          });
        }
        // Clear turn events for new turn display + transition phase
        entry.turnEvents = [];
        entry.pendingApprovalEvent = undefined;
        setPhase(sessionId, "thinking");
        console.log(`[chat] session=${sessionId} follow-up pushed to generator`);
      }
    } else if (parsed.type === "cancel") {
      // Fully teardown streaming session — user must resume to continue
      const provider = providerRegistry.get(providerId);
      provider?.abortQuery?.(sessionId);
    } else if (parsed.type === "approval_response") {
      const provider = providerRegistry.get(providerId);
      if (provider && typeof provider.resolveApproval === "function") {
        provider.resolveApproval(parsed.requestId, parsed.approved, (parsed as any).data);
      }
      if (entry) {
        entry.pendingApprovalEvent = undefined;
        // Broadcast approval cleared to all clients
        broadcast(sessionId, { type: "phase_changed", phase: entry.phase });
      }
    }
  },

  close(ws: ChatWsSocket) {
    const { sessionId } = ws.data;
    const entry = activeSessions.get(sessionId);
    if (!entry) return;

    // Remove from clients Set + clear per-client ping
    evictClient(entry, ws);
    console.log(`[chat] session=${sessionId} FE disconnected (phase=${entry.phase}, clients=${entry.clients.size})`);

    if (entry.clients.size === 0) {
      startCleanupTimer(sessionId);
    }
  },
};
