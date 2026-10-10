import { useEffect, useRef } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { hydrateWorkspaceFromServer } from "@/stores/panel-utils";
import { autoOpenFromUrl } from "@/hooks/use-url-sync";
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage } from "../../shared/web-push-payload";
import { isAssistantProject } from "../../shared/assistant-project";
import { openAssistant } from "@/components/assistant/open-assistant";

/** Show a notification's session in this window, the way a `?openChat=` link opens it at boot. */
async function openNotifiedSession(projectName: string, sessionId: string, providerId: string): Promise<void> {
  // An Assistant session is not in any project: it opens in the Assistant, over whatever is shown.
  if (isAssistantProject(projectName)) {
    openAssistant({ sessionId: sessionId || undefined, providerId: providerId || undefined });
    return;
  }
  const target = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!target) return;
  // Without a local copy of the layout, switching would create an empty one and overwrite the saved tabs.
  if (!localStorage.getItem(`ppm-panels-${target.name}`)) await hydrateWorkspaceFromServer(target.name);
  useProjectStore.getState().setActiveProject(target);
  useTabStore.getState().switchProject(target.name);
  // `provider/session` as in a chat URL; without the provider the tab would open as Claude.
  if (sessionId) autoOpenFromUrl("chat", providerId ? `${providerId}/${sessionId}` : sessionId, target.name);
}

/**
 * A click on a push notification, handed over by the service worker to this window
 * (it focuses the window itself). Signed out, the page goes to the notification's URL,
 * which opens the session once signed in.
 */
export function useNotificationClicks(authenticated: boolean): void {
  const authenticatedRef = useRef(authenticated);
  authenticatedRef.current = authenticated;

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as Partial<OpenFromNotificationMessage> | null;
      if (message?.type !== OPEN_FROM_NOTIFICATION || typeof message.url !== "string") return;
      if (!authenticatedRef.current) {
        if (new URL(message.url, window.location.href).origin === window.location.origin) window.location.assign(message.url);
        return;
      }
      void openNotifiedSession(message.project ?? "", message.sessionId ?? "", message.providerId ?? "");
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
