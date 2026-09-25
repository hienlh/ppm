/**
 * Global event bus WebSocket (`/ws/global`).
 *
 * One connection per browser client, independent of which tabs are open. It owns
 * two things that must not depend on a chat tab being mounted:
 *
 *  1. **Project file watching.** The watcher used to be started by the chat WS, so
 *     it only ran while a chat tab happened to be mounted. Tabs mount lazily now,
 *     so a workspace whose visible tabs are an editor and a terminal would get no
 *     file watching at all — silently breaking editor live-reload, docx/pdf
 *     preview reload, and file-tree invalidation.
 *  2. **Cross-cutting broadcasts** (`file:changed`, `files:index-changed`, `session:unread_changed`,
 *     `session:phase_changed`, `jira:*`, `design:*`). These are app-wide, not session-scoped,
 *     so they belong on an app-wide channel.
 *
 * Events go to global clients only — never also to chat clients — so a client
 * holding both connections cannot receive the same event twice (which would, for
 * example, make an editor re-fetch its file twice per change).
 */
import { startWatching, stopWatching, onFileChange } from "../../services/file-watcher.service.ts";
import { onIndexRebuilt } from "../../services/file-list-index.service.ts";
import { configService } from "../../services/config.service.ts";
import { onDesignEvent } from "../../services/design/design-events.ts";
import { resolve } from "node:path";
import {
  handleAgentActivitySubscribe, handleAgentActivityUnsubscribe,
  handleAgentTranscriptClientClosed, handleAgentTranscriptPing,
  handleAgentTranscriptSubscribe, handleAgentTranscriptUnsubscribe,
} from "../../services/agent-transcript/agent-transcript-hub.ts";
import type {
  AgentActivitySubscribeMsg, AgentActivityUnsubscribeMsg,
  AgentTranscriptSubscribeMsg, AgentTranscriptUnsubscribeMsg,
} from "../../shared/agent-transcript-protocol.ts";

type GlobalWsSocket = {
  /** Auth token snapshotted at upgrade (`server/index.ts`) — re-checked on every agent-transcript push. */
  data: { type: string; token?: string | null };
  send: (data: string) => number;
};

const clients = new Set<GlobalWsSocket>();
/** Project each client currently watches, so we can release its ref on switch/close. */
const watchedProject = new Map<GlobalWsSocket, string>();

/** Broadcast an app-wide event to every connected global client. */
export function broadcastGlobalEvent(event: unknown): void {
  const json = JSON.stringify(event);
  for (const ws of clients) {
    try { ws.send(json); } catch { /* client is going away; close() will clean up */ }
  }
}

/** Release this client's watch ref, if it holds one. */
function releaseWatch(ws: GlobalWsSocket): void {
  const previous = watchedProject.get(ws);
  if (previous === undefined) return;
  watchedProject.delete(ws);
  stopWatching(previous);
}

/**
 * Point a client's file watching at `projectName`.
 * The path is resolved server-side from config rather than taken from the client,
 * so a client cannot ask the server to watch an arbitrary directory.
 */
function setWatch(ws: GlobalWsSocket, projectName: string): void {
  if (watchedProject.get(ws) === projectName) return;
  releaseWatch(ws);
  if (!projectName) return;

  const project = configService.get("projects").find((p) => p.name === projectName);
  if (!project) return;

  void startWatching(projectName, project.path);
  watchedProject.set(ws, projectName);
}

// File changes are app-wide: relay them to every global client.
onFileChange((projectName, path) => {
  broadcastGlobalEvent({ type: "file:changed", projectName, path });
});

/** Registered project whose folder is `projectPath`, or null. Case-folded on Windows. */
function projectNameForPath(projectPath: string): string | null {
  const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const target = fold(projectPath);
  return configService.get("projects").find((p) => fold(p.path) === target)?.name ?? null;
}

// A project's file index was rebuilt behind a stale one and now lists other paths. Clients do
// not refetch the index on every `file:changed` (on a large project that is a 22 MB download
// per change); this is what tells them the list they hold is out of date.
onIndexRebuilt((projectPath, changed) => {
  if (!changed) return;
  const projectName = projectNameForPath(projectPath);
  if (projectName) broadcastGlobalEvent({ type: "files:index-changed", projectName });
});

// Design history/comment changes: `.design/` is not watched, so these are the only signal.
// Services know the project path; browsers address projects by name, and a path no
// registered project owns is dropped rather than broadcast.
onDesignEvent((type, { projectPath, slug, requestId, screenshot }) => {
  const projectName = projectNameForPath(projectPath);
  if (!projectName) return;
  broadcastGlobalEvent({
    type: `design:${type}`, projectName, slug,
    ...(requestId ? { requestId, screenshot: screenshot === true } : {}),
  });
});

export const globalWebSocket = {
  open(ws: GlobalWsSocket) {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "global_ready" }));
  },

  message(ws: GlobalWsSocket, raw: string | Buffer) {
    let msg: { type?: string; projectName?: string };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    // Sent on connect and whenever the active project changes.
    if (msg.type === "watch") return setWatch(ws, msg.projectName ?? "");
    if (msg.type === "agent-transcript:subscribe") return handleAgentTranscriptSubscribe(ws, msg as AgentTranscriptSubscribeMsg);
    if (msg.type === "agent-transcript:unsubscribe") return handleAgentTranscriptUnsubscribe(ws, msg as AgentTranscriptUnsubscribeMsg);
    if (msg.type === "agent-activity:subscribe") return handleAgentActivitySubscribe(ws, msg as AgentActivitySubscribeMsg);
    if (msg.type === "agent-activity:unsubscribe") return handleAgentActivityUnsubscribe(ws, msg as AgentActivityUnsubscribeMsg);
    if (msg.type === "ping") return handleAgentTranscriptPing(ws);
  },

  close(ws: GlobalWsSocket) {
    releaseWatch(ws);
    handleAgentTranscriptClientClosed(ws);
    clients.delete(ws);
  },
};
