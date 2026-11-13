import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { hydrateWorkspaceFromServer } from "@/stores/panel-utils";
import type { ExtTabPlacement } from "../../types/extension-messages.ts";
import { openPlacedTab } from "./extension-tab-placement";

export interface ExtensionChatTabRequest {
  title: string;
  metadata: { projectName: string; sessionId: string; providerId?: string };
  /** A floating window in front, beside the calling panel's (desktop only). */
  placement?: ExtTabPlacement;
  /** The server addressed this browser alone (`chat:openTab`), not every browser. */
  addressed?: boolean;
}

/**
 * Open a chat an extension asked for, in its project: the chat tab builds every URL from
 * `metadata.projectName`, and a tab opened under another project would 404 on all of them.
 * The project is switched to first, the way a notification click switches, so the tab lands
 * in the workspace it belongs to rather than in whichever one happens to be showing.
 */
export async function openExtensionChatTab(request: ExtensionChatTabRequest): Promise<boolean> {
  const { projectName, sessionId, providerId } = request.metadata;
  const target = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!target) return false;
  if (useTabStore.getState().currentProject !== target.name) {
    // Without a local copy of the layout, switching would create an empty one and overwrite the saved tabs.
    if (!localStorage.getItem(`ppm-panels-${target.name}`)) await hydrateWorkspaceFromServer(target.name);
    useProjectStore.getState().setActiveProject(target);
    useTabStore.getState().switchProject(target.name);
  }
  // Placed after the switch: the tabs the switch restores are not this request's to own.
  openPlacedTab(() => useTabStore.getState().openTab({
    type: "chat",
    title: request.title || "Chat",
    projectId: target.name,
    closable: true,
    metadata: { projectName: target.name, sessionId, ...(providerId ? { providerId } : {}) },
  }), request.placement, request.addressed ?? false);
  return true;
}
