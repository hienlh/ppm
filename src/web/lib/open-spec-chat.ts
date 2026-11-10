/** Opens the chat of a spec, or of one of its task chats, in a tab. */
import { useTabStore } from "@/stores/tab-store";
import { specsApi } from "@/lib/api-specs";

/**
 * Sessions whose chat must show its spec pane when it next mounts or hears `SPEC_PANE_EVENT`.
 * Opening an already-open chat only focuses its tab, so a pane the user had closed would stay
 * closed and the click would show nothing of the spec.
 */
const paneRequests = new Set<string>();
export const SPEC_PANE_EVENT = "ppm:spec-pane-open";

/** True once per request: the chat tab of `sessionId` should open its spec pane. */
export function takeSpecPaneRequest(sessionId: string): boolean {
  return paneRequests.delete(sessionId);
}

/** A spec knows its chats by id only; without the provider the tab would treat the chat as Claude's. */
export async function openSpecChat(
  projectName: string, sessionId: string, title: string, providerId?: string, opts?: { showSpec?: boolean },
): Promise<void> {
  if (!providerId) providerId = (await specsApi.bySession(projectName, sessionId).catch(() => null))?.providerId ?? undefined;
  if (opts?.showSpec) paneRequests.add(sessionId);
  useTabStore.getState().openTab({
    type: "chat",
    title,
    projectId: projectName,
    metadata: { projectName, sessionId, ...(providerId ? { providerId } : {}) },
    closable: true,
  });
  if (opts?.showSpec) window.dispatchEvent(new CustomEvent(SPEC_PANE_EVENT, { detail: { sessionId } }));
}
