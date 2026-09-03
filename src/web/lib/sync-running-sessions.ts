import { api, projectUrl } from "@/lib/api-client";
import { useStreamingStore } from "@/stores/streaming-store";

/**
 * Reconcile a project's streaming indicators (tab-strip spinner, title/favicon)
 * against the server's session registry.
 *
 * Runs on every `/ws/global` (re)connect and on project switch. Two gaps it
 * closes, both of which nothing else can:
 * - a turn running in a tab that is not mounted (tabs mount lazily, so its phase
 *   never reaches this client) → indicator missing;
 * - an `idle` broadcast that landed while the global socket was down → indicator
 *   stuck on until a full page reload.
 */
export async function syncRunningSessions(projectName: string | undefined): Promise<void> {
  if (!projectName) return;
  try {
    const running = await api.get<{ sessionId: string }[]>(
      `${projectUrl(projectName)}/chat/sessions/running`,
    );
    useStreamingStore
      .getState()
      .replaceProjectStreaming(projectName, running.map((s) => s.sessionId));
  } catch {
    // Never block boot or a reconnect on an indicator.
  }
}
