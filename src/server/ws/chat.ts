import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { logSessionEvent } from "../../services/session-log.service.ts";
import { listSessions as sdkListSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ChatWsClientMessage } from "../../types/api.ts";

const PING_INTERVAL_MS = 15_000; // 15s keepalive
const CLEANUP_TIMEOUT_MS = 5 * 60_000; // 5min after Claude done + no FE

type ChatWsSocket = {
  data: { type: string; sessionId: string; projectName?: string };
  send: (data: string) => void;
  ping?: (data?: string | ArrayBuffer) => void;
};

interface SessionEntry {
  providerId: string;
  ws: ChatWsSocket | null;
  abort?: AbortController;
  projectPath?: string;
  projectName?: string;
  pingInterval?: ReturnType<typeof setInterval>;
  isStreaming: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  pendingApprovalEvent?: { type: string; requestId: string; tool: string; input: unknown };
  /** When true, accumulate text events until next turn boundary, then flush as one message */
  needsCatchUp: boolean;
  /** Accumulated text content during catch-up phase */
  catchUpText: string;
  /** Reference to the running stream promise — prevents GC */
  streamPromise?: Promise<void>;
  /** Sticky permission mode for this session */
  permissionMode?: string;
}

/** Tracks active sessions — persists even when FE disconnects */
const activeSessions = new Map<string, SessionEntry>();

/** Check if any frontend client is currently connected via WebSocket */
export function hasActiveClient(): boolean {
  for (const entry of activeSessions.values()) {
    if (entry.ws) return true;
  }
  return false;
}

/** Send event to FE if connected, silently drop otherwise */
function safeSend(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry?.ws) {
    const evType = (event as any)?.type ?? "unknown";
    // Log ALL dropped events (including streaming_status) for debugging first-message issues
    if (evType !== "ping") {
      console.warn(`[chat] session=${sessionId} safeSend: ws=null, dropping ${evType}`);
    }
    return;
  }
  try {
    entry.ws.send(JSON.stringify(event));
  } catch (e) {
    console.warn(`[chat] session=${sessionId} safeSend: send failed (${(e as Error).message})`);
  }
}

/** Start cleanup timer — only called when Claude is done AND no FE connected */
function startCleanupTimer(sessionId: string): void {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = setTimeout(() => {
    console.log(`[chat] session=${sessionId} cleanup: no FE reconnected within timeout`);
    logSessionEvent(sessionId, "INFO", "Session cleaned up (no FE reconnected)");
    if (entry.pingInterval) clearInterval(entry.pingInterval);
    activeSessions.delete(sessionId);
  }, CLEANUP_TIMEOUT_MS);
}

/**
 * Standalone streaming loop — decoupled from WS message handler.
 * Runs independently so WS close does NOT kill the Claude query.
 */
async function runStreamLoop(sessionId: string, providerId: string, content: string, permissionMode?: string): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) {
    console.error(`[chat] session=${sessionId} runStreamLoop: no entry — aborting`);
    return;
  }
  const streamStartMs = Date.now();
  console.log(`[chat] session=${sessionId} runStreamLoop started (ws=${entry.ws ? "connected" : "null"})`);

  const abortController = new AbortController();
  entry.abort = abortController;
  entry.isStreaming = true;
  entry.pendingApprovalEvent = undefined;
  entry.needsCatchUp = false;
  entry.catchUpText = "";

  // Heartbeat interval — declared outside try so finally can clear it
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastContextWindowPct: number | undefined;

  try {
    const userPreview = content.slice(0, 200);
    logSessionEvent(sessionId, "USER", userPreview);
    console.log(`[chat] session=${sessionId} sending message to provider=${providerId}`);

    // Send "connecting" status with thinking config so FE can set appropriate warning threshold
    const { configService } = await import("../../services/config.service.ts");
    const ai = configService.get("ai");
    const pCfg = ai.providers[ai.default_provider ?? "claude"] ?? {};
    const effort = (pCfg as Record<string, unknown>).effort as string | undefined;
    const thinkingBudget = (pCfg as Record<string, unknown>).thinking_budget_tokens as number | undefined;
    safeSend(sessionId, { type: "streaming_status", status: "connecting", effort, thinkingBudget });

    let eventCount = 0;
    let firstEventReceived = false;
    const startTime = Date.now();

    // Heartbeat: while waiting for first response, send elapsed time every 5s
    // so FE can show "Connecting... (15s)" and warn if it takes too long
    const CONNECTION_TIMEOUT_S = 120; // 2min max wait for first SDK event
    heartbeat = setInterval(() => {
      if (firstEventReceived || abortController.signal.aborted) {
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
        safeSend(sessionId, {
          type: "error",
          message: `Claude SDK timed out after ${elapsed}s for project "${projectPath || "(no project)"}".${wslHint}\n\nDebug steps:\n1. Run in your terminal: \`${debugCmd}\`\n2. Check for hanging hooks/MCP servers: \`cat ${projectPath}/.claude/settings.local.json\`\n3. Try removing project Claude config: \`mv ${projectPath}/.claude ${projectPath}/.claude.bak\`\n4. If none of the above helps, try: \`claude login\` to refresh auth`,
        });
        abortController.abort();
        return;
      }
      safeSend(sessionId, { type: "streaming_status", status: "connecting", elapsed });
    }, 5_000);

    for await (const event of chatService.sendMessage(providerId, sessionId, content, { permissionMode })) {
      if (abortController.signal.aborted) break;
      eventCount++;
      const ev = event as any;
      const evType = ev.type ?? "unknown";

      // First content event — stop heartbeat, switch to streaming status.
      // Skip metadata events (account_info, streaming_status) that arrive before
      // the SDK subprocess actually produces output — keeps heartbeat + "connecting"
      // indicator alive until real content flows.
      const isMetadataEvent = evType === "account_info" || evType === "streaming_status";
      if (!firstEventReceived && !isMetadataEvent) {
        firstEventReceived = true;
        const waitMs = Date.now() - startTime;
        console.log(`[chat] session=${sessionId} first SDK event after ${waitMs}ms: type=${evType}`);
        logSessionEvent(sessionId, "PERF", `First SDK event after ${waitMs}ms (type=${evType})`);
        if (heartbeat) clearInterval(heartbeat);
        safeSend(sessionId, { type: "streaming_status", status: "streaming" });
      }

      // Log every event
      if (evType === "text") {
        logSessionEvent(sessionId, "TEXT", ev.content?.slice(0, 500) ?? "");
      } else if (evType === "tool_use") {
        logSessionEvent(sessionId, "TOOL_USE", `${ev.tool} ${JSON.stringify(ev.input).slice(0, 300)}`);
      } else if (evType === "tool_result") {
        logSessionEvent(sessionId, "TOOL_RESULT", `error=${ev.isError ?? false} ${(ev.output ?? "").slice(0, 300)}`);
      } else if (evType === "error") {
        logSessionEvent(sessionId, "ERROR", ev.message ?? JSON.stringify(ev).slice(0, 300));
      } else if (evType === "done") {
        logSessionEvent(sessionId, "DONE", `subtype=${ev.resultSubtype ?? "none"} turns=${ev.numTurns ?? "?"} ctx=${ev.contextWindowPct ?? "?"}%`);
        if (ev.contextWindowPct != null) lastContextWindowPct = ev.contextWindowPct;
        // Fire-and-forget: fetch updated session title from SDK summary
        sdkListSessions({ dir: entry.projectPath, limit: 50 }).then((sessions) => {
          const found = sessions.find((s) => s.sessionId === sessionId || s.sessionId === ev.sessionId);
          const title = found?.customTitle ?? found?.summary;
          if (title) {
            safeSend(sessionId, { type: "title_updated", title });
            // Also update in-memory session title
            const session = chatService.getSession(sessionId);
            if (session) session.title = title;
          }
        }).catch(() => {});
        // Fire-and-forget notification broadcast (push + telegram)
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
        // Fire-and-forget notification for approval/question
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
      } else {
        logSessionEvent(sessionId, evType.toUpperCase(), JSON.stringify(ev).slice(0, 200));
      }

      // Catch-up mode: accumulate text, flush on turn boundary
      if (entry.needsCatchUp) {
        if (evType === "text") {
          entry.catchUpText += ev.content ?? "";
        } else {
          // Non-text event = turn boundary → flush accumulated text, then send this event
          if (entry.catchUpText) {
            safeSend(sessionId, { type: "text", content: entry.catchUpText });
          }
          entry.needsCatchUp = false;
          entry.catchUpText = "";
          safeSend(sessionId, event);
        }
      } else {
        safeSend(sessionId, event);
      }
    }

    logSessionEvent(sessionId, "INFO", `Stream completed (${eventCount} events)`);
    console.log(`[chat] session=${sessionId} stream completed (${eventCount} events)`);
  } catch (e) {
    const errMsg = (e as Error).message;
    logSessionEvent(sessionId, "ERROR", `Exception: ${errMsg}`);
    if (!abortController.signal.aborted) {
      safeSend(sessionId, { type: "error", message: errMsg });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Always send done — guarantees FE resets isStreaming even if provider didn't yield done
    safeSend(sessionId, { type: "done", sessionId, contextWindowPct: lastContextWindowPct });
    entry.abort = undefined;
    entry.isStreaming = false;
    entry.pendingApprovalEvent = undefined;
    entry.needsCatchUp = false;
    entry.catchUpText = "";
    // Claude is done — if no FE connected, start cleanup timer
    if (!entry.ws) {
      startCleanupTimer(sessionId);
    }
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
      // FE reconnecting to existing session — replace ws, clear cleanup timer
      if (existing.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
        existing.cleanupTimer = undefined;
      }
      if (existing.pingInterval) clearInterval(existing.pingInterval);
      // Use application-level pings (JSON messages) instead of protocol-level ws.ping().
      // Protocol-level pings can be intercepted by Cloudflare tunnels, causing the server
      // to think the connection is alive when the data path to the client is broken.
      existing.pingInterval = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch { /* ws may be closed */ }
      }, PING_INTERVAL_MS);
      existing.ws = ws;
      if (projectPath) existing.projectPath = projectPath;
      if (projectName) existing.projectName = projectName;

      // If streaming, enter catch-up mode
      if (existing.isStreaming) {
        existing.needsCatchUp = true;
        existing.catchUpText = "";
      }

      ws.send(JSON.stringify({
        type: "status",
        sessionId,
        isStreaming: existing.isStreaming,
        pendingApproval: existing.pendingApprovalEvent ?? null,
        sessionTitle: session?.title || null,
      }));
      // Async: resolve title from SDK if in-memory title is generic
      if (!session?.title || session.title === "Chat" || session.title === "Resumed Chat") {
        sdkListSessions({ dir: projectPath, limit: 50 }).then((sessions) => {
          const found = sessions.find((s) => s.sessionId === sessionId);
          const title = found?.customTitle ?? found?.summary;
          if (title) {
            safeSend(sessionId, { type: "title_updated", title });
            if (session) session.title = title;
          }
        }).catch(() => {});
      }
      console.log(`[chat] session=${sessionId} FE reconnected (streaming=${existing.isStreaming}, catchUp=${existing.needsCatchUp})`);
      return;
    }

    // New session entry — use application-level pings for Cloudflare tunnel compatibility
    const pingInterval = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch { /* ws may be closed */ }
    }, PING_INTERVAL_MS);

    activeSessions.set(sessionId, {
      providerId,
      ws,
      projectPath,
      projectName,
      pingInterval,
      isStreaming: false,
      needsCatchUp: false,
      catchUpText: "",
    });
    ws.send(JSON.stringify({ type: "connected", sessionId, sessionTitle: session?.title || null }));
    // Async: resolve title from SDK if in-memory title is generic
    if (!session?.title || session.title === "Chat" || session.title === "Resumed Chat") {
      sdkListSessions({ dir: projectPath, limit: 50 }).then((sessions) => {
        const found = sessions.find((s) => s.sessionId === sessionId);
        const title = found?.customTitle ?? found?.summary;
        if (title) {
          safeSend(sessionId, { type: "title_updated", title });
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

    // Ensure entry.ws is current — may be stale if open/close race during reconnect
    const entry0 = activeSessions.get(sessionId);
    if (entry0 && entry0.ws !== ws) {
      entry0.ws = ws;
    }

    let entry = activeSessions.get(sessionId);

    // Auto-create entry if missing — handles: message before open (Bun race), or session cleaned up
    if (!entry) {
      const { projectName: pn } = ws.data;
      const session = chatService.getSession(sessionId);
      const pid = session?.providerId ?? providerRegistry.getDefault().id;
      let pp: string | undefined;
      if (pn) { try { pp = resolveProjectPath(pn); } catch { /* ignore */ } }
      const pi = setInterval(() => {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ws may be closed */ }
      }, PING_INTERVAL_MS);
      activeSessions.set(sessionId, {
        providerId: pid, ws, projectPath: pp, projectName: pn,
        pingInterval: pi, isStreaming: false, needsCatchUp: false, catchUpText: "",
      });
      entry = activeSessions.get(sessionId)!;
      console.log(`[chat] session=${sessionId} auto-created entry in message handler`);
    }

    const providerId = entry.providerId ?? providerRegistry.getDefault().id;

    // Client-initiated handshake — FE sends "ready" after onopen.
    // Re-send status so tunnel connections (Cloudflare) that missed the
    // open-handler message still get connected/status confirmation.
    if (parsed.type === "ready") {
      ws.send(JSON.stringify({
        type: "status",
        sessionId,
        isStreaming: entry.isStreaming,
        pendingApproval: entry.pendingApprovalEvent ?? null,
      }));
      return;
    }

    if (parsed.type === "message") {
      // Store permission mode — sticky for this session
      if (parsed.permissionMode) {
        entry.permissionMode = parsed.permissionMode;
      }

      // Send immediate feedback BEFORE any async work — prevents "stuck thinking"
      // when resumeSession is slow (e.g. sdkListSessions spawns subprocess on first call)
      safeSend(sessionId, { type: "streaming_status", status: "connecting", elapsed: 0 });

      // Resume session in provider (can be slow on first call — sdkListSessions)
      const provider = providerRegistry.get(providerId);
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

      // If already streaming, abort current query first and wait for cleanup
      if (entry.isStreaming && entry.abort) {
        console.log(`[chat] session=${sessionId} aborting current query for new message`);
        entry.abort.abort();
        // Wait for stream loop to finish cleanup
        if (entry.streamPromise) {
          await entry.streamPromise;
        }
      }

      // Store promise reference on entry to prevent GC from collecting the async operation.
      // Use setTimeout(0) to detach from WS handler's async scope.
      entry.streamPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          runStreamLoop(sessionId, providerId, parsed.content, entry.permissionMode).then(resolve, resolve);
        }, 0);
      });
    } else if (parsed.type === "cancel") {
      const provider = providerRegistry.get(providerId);
      if (provider && "abortQuery" in provider && typeof (provider as any).abortQuery === "function") {
        (provider as any).abortQuery(sessionId);
      }
    } else if (parsed.type === "approval_response") {
      const provider = providerRegistry.get(providerId);
      if (provider && typeof provider.resolveApproval === "function") {
        provider.resolveApproval(parsed.requestId, parsed.approved, (parsed as any).data);
      }
      if (entry) entry.pendingApprovalEvent = undefined;
    }
  },

  close(ws: ChatWsSocket) {
    const { sessionId } = ws.data;
    const entry = activeSessions.get(sessionId);
    if (!entry) return;

    if (entry.pingInterval) {
      clearInterval(entry.pingInterval);
      entry.pingInterval = undefined;
    }

    // Detach FE — do NOT abort Claude
    entry.ws = null;
    console.log(`[chat] session=${sessionId} FE disconnected (streaming=${entry.isStreaming})`);

    if (!entry.isStreaming) {
      startCleanupTimer(sessionId);
    }
  },
};
