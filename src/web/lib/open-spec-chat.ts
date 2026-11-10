/** Opens the chat of a spec, or of one of its task chats, in a tab. */
import { useTabStore } from "@/stores/tab-store";
import { specsApi } from "@/lib/api-specs";

/** A spec knows its chats by id only; without the provider the tab would treat the chat as Claude's. */
export async function openSpecChat(projectName: string, sessionId: string, title: string, providerId?: string): Promise<void> {
  if (!providerId) providerId = (await specsApi.bySession(projectName, sessionId).catch(() => null))?.providerId ?? undefined;
  useTabStore.getState().openTab({
    type: "chat",
    title,
    projectId: projectName,
    metadata: { projectName, sessionId, ...(providerId ? { providerId } : {}) },
    closable: true,
  });
}
