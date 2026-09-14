import { api } from "@/lib/api-client";
import { useStreamingStore } from "@/stores/streaming-store";

/**
 * Reconcile the streaming indicators (tab-strip spinner, title/favicon, screen wake lock)
 * against the server's session registry.
 *
 * Runs on every `/ws/global` (re)connect and on project switch. Three gaps it closes, none of
 * which anything else can:
 * - a turn running in a tab that is not mounted (tabs mount lazily, so its phase never reaches
 *   this client) → indicator missing;
 * - an `idle` broadcast that landed while the global socket was down → indicator stuck on;
 * - a session the server forgot without ever going idle — a restart mid-turn, an id the
 *   provider re-keyed → an entry with no `idle` coming at all.
 *
 * Deliberately not scoped to a project. The server's list covers every project, so the whole
 * map is replaced in one shot; a per-project sync could only reach the project on screen and
 * left everything else to rot.
 */
export async function syncRunningSessions(): Promise<void> {
  try {
    const running = await api.get<{ sessionId: string; projectName: string }[]>(
      "/api/chat/sessions/running",
    );
    useStreamingStore.getState().replaceAllStreaming(running);
  } catch {
    // Never block boot or a reconnect on an indicator.
  }
}
