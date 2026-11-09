/**
 * Show a chat session in this window whichever project it belongs to, the way a `?openChat=`
 * link opens it at boot. Shared by notification clicks and turn chips; the project switch itself
 * (pulling the saved layout first when this browser has none) is `showProjectTab`'s.
 */
import { ppmUrlState, showProjectTab } from "@/lib/open-ppm-tab";
import { isAssistantProject } from "../../shared/assistant-project";
import { openAssistant } from "@/components/assistant/open-assistant";

/**
 * Open `sessionId` of `projectName`. With no session, `url` names the tab to open instead (a
 * notification about a design, say). False when this PPM has no such project. An Assistant
 * session is not in any project: it opens in the Assistant, over whatever is shown.
 */
export async function openSessionAnywhere(projectName: string, sessionId: string, providerId: string, url?: string): Promise<boolean> {
  if (isAssistantProject(projectName)) {
    openAssistant({ sessionId: sessionId || undefined, providerId: providerId || undefined });
    return true;
  }
  // `provider/session` as in a chat URL; without the provider the tab would open as Claude.
  if (sessionId) return showProjectTab(projectName, "chat", providerId ? `${providerId}/${sessionId}` : sessionId);
  const state = url ? ppmUrlState(url) : null;
  return showProjectTab(projectName, state?.projectName === projectName ? state.tabType : null, state?.tabIdentifier ?? null);
}
