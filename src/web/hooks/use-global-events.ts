import { useEffect, useRef } from "react";
import { WsClient } from "@/lib/ws-client";
import { getAuthToken } from "@/lib/api-client";
import { useNotificationStore } from "@/stores/notification-store";
import { useStreamingStore } from "@/stores/streaming-store";
import { useFileStore } from "@/stores/file-store";
import { syncRunningSessions } from "@/lib/sync-running-sessions";
import { syncAllKnownProjects, syncKnownProject } from "@/stores/session-list-sync-triggers";
import { notifyGlobalReady, sendIfOpen, setGlobalWsClient } from "@/lib/global-ws-channel";
import { SESSION_FILE_CHANGES_PUSH } from "../../shared/session-file-changes";
import {
  SESSION_COLLAB_APPROVAL_EVENT, SESSION_CREATED_EVENT, SESSION_LINK_CHANGED_EVENT, type SessionCollabGlobalEvent,
} from "../../shared/session-collab";
import { handleSessionCollabEvent } from "@/lib/session-collab-events";
import { resyncManagerChats } from "./use-manager-chats";
import { resyncAssistantCards } from "@/stores/assistant-cards-store";
import { resyncAssistantWaiting } from "@/stores/assistant-waiting-store";
import { useProjectStore } from "@/stores/project-store";
import { PROJECTS_CHANGED_EVENT } from "../../shared/projects-events";
import { DB_CONNECTIONS_CHANGED_EVENT, DB_CONNECTIONS_CHANGED_WINDOW_EVENT } from "../../shared/db-connection-events";
import { SETTINGS_CHANGED_EVENT, isSettingsSection } from "../../shared/settings-events";
import { handleSettingsChanged } from "@/lib/settings-live-refresh";

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
 *   project that is a 22 MB download — unless something is showing it right now (the palette,
 *   a picker; see `openIndexReader`); otherwise it is refreshed when something opens to read it.
 * - `projects:changed` → refetches the project list: the server added a project itself (the
 *   Assistant's `project_add`).
 * - `db:connections_changed` → the Database sidebar and connection lists read theirs again.
 * - `settings:changed {section}` → the theme is re-applied and imported themes or keybindings
 *   reloaded (`settings-live-refresh.ts`); open Settings panes re-read via `useSettingsChanged`.
 * - `session:unread_changed` → cross-device unread sync.
 * - `session:phase_changed` → keeps the tab-strip spinner and title indicator
 *   correct for sessions whose tab is not mounted, and — critically — clears them
 *   when the turn ends. Nothing else can: `useChat` only runs while mounted.
 *   On every (re)connect the indicators are also reconciled against the server
 *   registry, since a phase change that happened while this socket was down was
 *   never delivered and would otherwise stick until a full reload.
 * - `sessions:list_changed` → re-syncs that project's session list, when this browser holds one.
 *   The server sends it for sessions no browser asked for (the Assistant's tools, Telegram).
 * - `assistant:*` → re-dispatched as window events (`assistant:telegram_binding_changed`,
 *   which moves the "Telegram" label in the Assistant's session list).
 * - `session:created` / `session:link_changed` / `session:collab_approval` → sessions reaching
 *   each other: a created session joins the session list at once, and links and cards land in
 *   `session-collab-store` for the linked-sessions bar (also re-dispatched as window events).
 * - `jira:*` → re-dispatched as window events.
 * - `schedules:*` → re-dispatched as window events (`schedules:changed` after any write to
 *   `/api/schedules`, from this device, another one or the Assistant's tools).
 * - `tunnel:*` → re-dispatched as window events (named-tunnel setup flow —
 *   login URL/state, setup progress/done/pending/error).
 * - `git:*` → re-dispatched as window events (`git:changed` after any write PPM
 *   makes to a repository, `git:commit-draft` when the shared commit message changes).
 * - `session:file-changes` → re-dispatched as a window event: the rows of the files the agent
 *   just changed, for the changes bar of that session (`useSessionFileChanges`).
 * - `feature-intros:changed` → re-dispatched as a window event: a new-feature question was
 *   answered, put off or settled on some device, so the tour and Settings → Tools refetch.
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
        resyncManagerChats();
        resyncAssistantCards();
        resyncAssistantWaiting();
        notifyGlobalReady();
        return;
      }

      if (type === "file:changed") {
        if (typeof data.projectName === "string") useFileStore.getState().markIndexStale(data.projectName);
        window.dispatchEvent(new CustomEvent("file:changed", { detail: data }));
        return;
      }

      if (type === "files:index-changed") {
        if (typeof data.projectName === "string") useFileStore.getState().indexRebuilt(data.projectName);
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

      if (type === "sessions:list_changed") {
        // Sessions created on the server's own initiative (an Assistant tool, a Telegram `/new`)
        // reach no chat socket, so without this the list would show them only after the tab was
        // hidden and shown again, or the socket reconnected.
        if (typeof data.projectName === "string" && data.projectName) syncKnownProject(data.projectName);
        return;
      }

      if (type === PROJECTS_CHANGED_EVENT) {
        void useProjectStore.getState().fetchProjects();
        return;
      }

      if (type === SETTINGS_CHANGED_EVENT) {
        // App-wide state (theme, keybindings) is refreshed here; open panes re-read on the window event.
        if (isSettingsSection(data.section)) handleSettingsChanged(data.section);
        return;
      }

      if (type === DB_CONNECTIONS_CHANGED_EVENT) {
        // The Database sidebar and the connection lists read their list again on this event.
        window.dispatchEvent(new CustomEvent(DB_CONNECTIONS_CHANGED_WINDOW_EVENT, { detail: {} }));
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

      if (type === SESSION_CREATED_EVENT || type === SESSION_LINK_CHANGED_EVENT || type === SESSION_COLLAB_APPROVAL_EVENT) {
        handleSessionCollabEvent(data as unknown as SessionCollabGlobalEvent);
        window.dispatchEvent(new CustomEvent(type, { detail: data }));
        return;
      }

      if (
        type.startsWith("jira:")
        || type.startsWith("tunnel:")
        || type.startsWith("tailscale:")
        || type.startsWith("design:")
        || type.startsWith("git:")
        || type.startsWith("agent-transcript:")
        || type.startsWith("logs:")
        || type.startsWith("assistant:")
        || type.startsWith("schedules:")
        || type.startsWith("feature-intros:")
        || type === "agent-activity"
        || type === SESSION_FILE_CHANGES_PUSH
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
