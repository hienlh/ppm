import { useEffect, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { getAuthToken } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useFileStore } from "@/stores/file-store";
import { syncRunningSessions } from "@/lib/sync-running-sessions";
import { syncAllKnownProjects } from "@/stores/session-list-sync-triggers";
import { notifyGlobalReady, sendIfOpen, setGlobalWsClient } from "@/lib/global-ws-channel";

/** How often the client pings — well under the server's own idle timeout, so a live but
 *  silent socket never gets reaped as dead. */
const PING_INTERVAL_MS = 20_000;
/** No message (including a pong) for this long means the socket is dead even though it
 *  never fired close/error — force a fresh connect rather than waiting on the browser. */
const IDLE_TIMEOUT_MS = 45_000;

/**
 * App-wide event bus client (`/ws/global`).
 *
 * These events used to ride on the chat WebSocket and were re-dispatched from
 * inside `useChat`, so they only arrived while a chat tab happened to be mounted.
 * Tabs mount lazily now, so they live on their own always-on connection.
 *
 * Handles:
 * - `file:changed` → re-dispatched as a window event for the editor, previews and
 *   file tree to consume, and marks the file index stale.
 * - `files:index-changed` → marks the file index stale: the server rebuilt it behind the list
 *   it had been serving, and the paths differ. Neither event fetches the index — on a large
 *   project that is a 22 MB download — so it is refreshed only when something opens to read it.
 * - `session:unread_changed` → cross-device unread sync.
 * - `session:phase_changed` → keeps the tab-strip spinner and title indicator
 *   correct for sessions whose tab is not mounted, and — critically — clears them
 *   when the turn ends. Nothing else can: `useChat` only runs while mounted.
 *   On every (re)connect the indicators are also reconciled against the server
 *   registry, since a phase change that happened while this socket was down was
 *   never delivered and would otherwise stick until a full reload.
 * - `jira:*` → re-dispatched as window events.
 * - `tunnel:*` → re-dispatched as window events (named-tunnel setup flow —
 *   login URL/state, setup progress/done/pending/error).
 * - `design:*` → re-dispatched as window events (`design:history_changed`,
 *   `design:comments_changed`). A design's `.design/` folder is not watched, so these
 *   are the only signal that its snapshots or comments changed.
 *
 * - `agent-transcript:events` / `agent-transcript:error` / `agent-activity` → re-dispatched
 *   as window events for `useAgentSessionStream` and the running-agents bar. Several of
 *   those hooks can be subscribed at once (one per open session window), each filtering the
 *   broadcast down to its own `subId` — same pattern as the other re-dispatches here.
 *
 * Also tells the server which project to watch, so file watching follows the
 * active project instead of depending on a chat socket existing.
 *
 * Registers its `WsClient` with `global-ws-channel` and pings every 20s: the hub protocol's
 * subscriptions (`useAgentSessionStream`) must never queue a send while this socket is
 * down, so they need to know the instant it actually goes idle rather than only on the next
 * browser-level close/error.
 */
export function useGlobalEvents(enabled: boolean, projectName?: string): void {
  const clientRef = useRef<WsClient | null>(null);
  // Read inside the message handler so a reconnect re-watches the current project
  // without having to tear down the connection.
  const projectRef = useRef<string | undefined>(projectName);
  projectRef.current = projectName;

  useEffect(() => {
    if (!enabled) return;

    const token = getAuthToken();
    const client = new WsClient(`/ws/global${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    clientRef.current = client;
    setGlobalWsClient(client);

    const unsubscribe = client.onMessage((event) => {
      let data: { type?: string; [k: string]: unknown };
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const type = data.type;
      if (typeof type !== "string") return;

      // Sent by the server on every (re)connect — re-arm watching for the project
      // that is active right now, which may have changed since the last connect.
      if (type === "global_ready") {
        if (projectRef.current) {
          client.send(JSON.stringify({ type: "watch", projectName: projectRef.current }));
        }
        void syncRunningSessions();
        // Missed session/tag updates while the socket was down (another
        // device renamed, pinned or deleted a session) — re-sync every
        // project this browser already knows about.
        syncAllKnownProjects();
        notifyGlobalReady();
        return;
      }

      if (type === "file:changed") {
        if (typeof data.projectName === "string") useFileStore.getState().markIndexStale(data.projectName);
        window.dispatchEvent(new CustomEvent("file:changed", { detail: data }));
        return;
      }

      if (type === "files:index-changed") {
        if (typeof data.projectName === "string") useFileStore.getState().markIndexStale(data.projectName);
        return;
      }

      if (type === "session:unread_changed") {
        const d = data as unknown as {
          sessionId: string; unreadCount: number; unreadType: string | null;
          projectName: string; sessionTitle: string | null; manual?: boolean;
        };
        useNotificationStore.getState().handleUnreadChanged(
          d.sessionId, d.unreadCount, d.unreadType as never, d.projectName, d.sessionTitle, d.manual,
        );
        return;
      }

      if (type === "session:phase_changed") {
        const d = data as unknown as { sessionId: string; phase: string; projectName?: string };
        useStreamingStore.getState().setStreaming(d.sessionId, d.phase !== "idle", d.projectName);
        return;
      }

      if (type === "session:migrated") {
        // The server re-keyed the session, so every phase change from here on carries the new
        // id and the old one's `idle` will never arrive. Drop it now rather than waiting for
        // the next reconnect to reconcile it away — a socket that stays up for hours would
        // hold the screen awake for just as long.
        const d = data as unknown as { oldSessionId: string; newSessionId: string };
        useStreamingStore.getState().dropSession(d.oldSessionId);
        return;
      }

      if (
        type.startsWith("jira:")
        || type.startsWith("tunnel:")
        || type.startsWith("design:")
        || type.startsWith("agent-transcript:")
        || type === "agent-activity"
      ) {
        window.dispatchEvent(new CustomEvent(type, { detail: data }));
      }
    });

    client.connect();
    const pingTimer = setInterval(() => {
      sendIfOpen(JSON.stringify({ type: "ping" }));
    }, PING_INTERVAL_MS);

    return () => {
      clearInterval(pingTimer);
      unsubscribe();
      client.disconnect();
      clientRef.current = null;
      setGlobalWsClient(null);
    };
  }, [enabled]);

  // Follow project switches. WsClient queues the message if still connecting, and
  // the `global_ready` handler above covers reconnects.
  useEffect(() => {
    if (!enabled || !projectName) return;
    clientRef.current?.send(JSON.stringify({ type: "watch", projectName }));
    void syncRunningSessions();
  }, [enabled, projectName]);
}
