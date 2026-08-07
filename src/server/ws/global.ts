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
 *  2. **Cross-cutting broadcasts** (`file:changed`, `session:unread_changed`,
 *     `session:phase_changed`, `jira:*`). These are app-wide, not session-scoped,
 *     so they belong on an app-wide channel.
 *
 * Events go to global clients only — never also to chat clients — so a client
 * holding both connections cannot receive the same event twice (which would, for
 * example, make an editor re-fetch its file twice per change).
 */
import { startWatching, stopWatching, onFileChange } from "../../services/file-watcher.service.ts";
import { configService } from "../../services/config.service.ts";

type GlobalWsSocket = {
  data: { type: string };
  send: (data: string) => void;
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

  startWatching(projectName, project.path);
  watchedProject.set(ws, projectName);
}

// File changes are app-wide: relay them to every global client.
onFileChange((projectName, path) => {
  broadcastGlobalEvent({ type: "file:changed", projectName, path });
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
    if (msg.type === "watch") setWatch(ws, msg.projectName ?? "");
  },

  close(ws: GlobalWsSocket) {
    releaseWatch(ws);
    clients.delete(ws);
  },
};
