/**
 * Show a chat session in this window whichever project it belongs to, the way a `?openChat=`
 * link opens it at boot: switch to the project (pulling its saved layout first when this browser
 * has none), then open or focus the session's tab. Shared by notification clicks and turn chips.
 */
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { hydrateWorkspaceFromServer } from "@/stores/panel-utils";
import { autoOpenFromUrl, parseUrlState } from "@/hooks/use-url-sync";

/**
 * Open `sessionId` of `projectName`. With no session, `url` names the tab to open instead (a
 * notification about a design, say). False when this PPM has no such project.
 */
export async function openSessionAnywhere(projectName: string, sessionId: string, providerId: string, url?: string): Promise<boolean> {
  const target = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!target) return false;
  // Without a local copy of the layout, switching would create an empty one and overwrite the saved tabs.
  if (!localStorage.getItem(`ppm-panels-${target.name}`)) await hydrateWorkspaceFromServer(target.name);
  useProjectStore.getState().setActiveProject(target);
  useTabStore.getState().switchProject(target.name);
  // `provider/session` as in a chat URL; without the provider the tab would open as Claude.
  if (sessionId) {
    autoOpenFromUrl("chat", providerId ? `${providerId}/${sessionId}` : sessionId, target.name);
    return true;
  }
  const state = url ? sameOriginTab(url) : null;
  if (state?.tabType && state.projectName === target.name) autoOpenFromUrl(state.tabType, state.tabIdentifier, target.name);
  return true;
}

function sameOriginTab(url: string): ReturnType<typeof parseUrlState> | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin ? parseUrlState(parsed) : null;
  } catch {
    return null;
  }
}
