import { chatService } from "../../services/chat.service.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { logSessionEvent } from "../../services/session-log.service.ts";
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
}

/** Tracks active sessions — persists even when FE disconnects */
const activeSessions = new Map<string, SessionEntry>();

/** Send event to FE if connected, silently drop otherwise */
function safeSend(sessionId: string, event: unknown): void {
  const entry = activeSessions.get(sessionId);
  if (!entry?.ws) return;
  try {
    entry.ws.send(JSON.stringify(event));
  } catch {
    // WS may have closed between check and send — ignore
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
async function runStreamLoop(sessionId: string, providerId: string, content: string): Promise<void> {
  const entry = activeSessions.get(sessionId);
  if (!entry) return;

  const abortController = new AbortController();
  entry.abort = abortController;
  entry.isStreaming = true;
  entry.pendingApprovalEvent = undefined;
  entry.needsCatchUp = false;
  entry.catchUpText = "";

  try {
    const userPreview = content.slice(0, 200);
    logSessionEvent(sessionId, "USER", userPreview);
    console.log(`[chat] session=${sessionId} sending message to provider=${providerId}`);
    let eventCount = 0;


    for await (const event of chatService.sendMessage(providerId, sessionId, content)) {
      if (abortController.signal.aborted) break;
      eventCount++;
      const ev = event as any;
      const evType = ev.type ?? "unknown";

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
        logSessionEvent(sessionId, "DONE", `subtype=${ev.resultSubtype ?? "none"} turns=${ev.numTurns ?? "?"}`);
        // Fire-and-forget push notification
        import("../../services/push-notification.service.ts").then(({ pushService }) => {
          const project = entry.projectName || "Project";
          const session = chatService.getSession(sessionId);
          const sessionTitle = session?.title || `Session ${sessionId.slice(0, 8)}`;
          pushService.notifyAll("Chat completed", `${project} — ${sessionTitle}`).catch(() => {});
        }).catch(() => {});
      } else if (evType === "approval_request") {
        entry.pendingApprovalEvent = ev;
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
      existing.pingInterval = setInterval(() => {
        try {
          if (ws.ping) ws.ping();
          else ws.send(JSON.stringify({ type: "ping" }));
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
      }));
      console.log(`[chat] session=${sessionId} FE reconnected (streaming=${existing.isStreaming}, catchUp=${existing.needsCatchUp})`);
      return;
    }

    // New session entry
    const pingInterval = setInterval(() => {
      try {
        if (ws.ping) ws.ping();
        else ws.send(JSON.stringify({ type: "ping" }));
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
    ws.send(JSON.stringify({ type: "connected", sessionId }));
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

    const entry = activeSessions.get(sessionId);
    const providerId = entry?.providerId ?? providerRegistry.getDefault().id;

    if (parsed.type === "message") {
      // Resume session in provider first
      const provider = providerRegistry.get(providerId);
      if (provider && "resumeSession" in provider) {
        await (provider as any).resumeSession(sessionId);
      }
      if (entry?.projectPath && provider && "ensureProjectPath" in provider) {
        (provider as any).ensureProjectPath(sessionId, entry.projectPath);
      }

      // Store promise reference on entry to prevent GC from collecting the async operation.
      // Use setTimeout(0) to detach from WS handler's async scope.
      if (entry) {
        entry.streamPromise = new Promise<void>((resolve) => {
          setTimeout(() => {
            runStreamLoop(sessionId, providerId, parsed.content).then(resolve, resolve);
          }, 0);
        });
      } else {
        setTimeout(() => runStreamLoop(sessionId, providerId, parsed.content), 0);
      }
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
