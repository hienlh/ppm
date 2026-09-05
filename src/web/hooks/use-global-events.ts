import { useEffect, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { getAuthToken } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { syncRunningSessions } from "@/lib/sync-running-sessions";

/**
 * App-wide event bus client (`/ws/global`).
 *
 * These events used to ride on the chat WebSocket and were re-dispatched from
 * inside `useChat`, so they only arrived while a chat tab happened to be mounted.
 * Tabs mount lazily now, so they live on their own always-on connection.
 *
 * Handles:
 * - `file:changed` → re-dispatched as a window event for the editor, previews and
 *   file tree to consume.
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
 *
 * Also tells the server which project to watch, so file watching follows the
 * active project instead of depending on a chat socket existing.
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
    const client = new WsClient(`/ws/global${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    clientRef.current = client;

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
        void syncRunningSessions(projectRef.current);
        return;
      }

      if (type === "file:changed") {
        window.dispatchEvent(new CustomEvent("file:changed", { detail: data }));
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

      if (type.startsWith("jira:") || type.startsWith("tunnel:")) {
        window.dispatchEvent(new CustomEvent(type, { detail: data }));
      }
    });

    client.connect();

    return () => {
      unsubscribe();
      client.disconnect();
      clientRef.current = null;
    };
  }, [enabled]);

  // Follow project switches. WsClient queues the message if still connecting, and
  // the `global_ready` handler above covers reconnects.
  useEffect(() => {
    if (!enabled || !projectName) return;
    clientRef.current?.send(JSON.stringify({ type: "watch", projectName }));
    void syncRunningSessions(projectName);
  }, [enabled, projectName]);
}
