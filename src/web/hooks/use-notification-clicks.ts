import { useEffect, useRef } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { hydrateWorkspaceFromServer } from "@/stores/panel-utils";
import { autoOpenFromUrl, parseUrlState } from "@/hooks/use-url-sync";
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage } from "../../shared/web-push-payload";

/**
 * Show a notification's session in this window, the way a `?openChat=` link opens it at boot.
 * A notification about something other than a chat (a design a reviewer commented on) opens
 * the tab its URL names, as that URL would at boot.
 */
async function openNotifiedSession(projectName: string, sessionId: string, providerId: string, url: string): Promise<void> {
  const target = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!target) return;
  // Without a local copy of the layout, switching would create an empty one and overwrite the saved tabs.
  if (!localStorage.getItem(`ppm-panels-${target.name}`)) await hydrateWorkspaceFromServer(target.name);
  useProjectStore.getState().setActiveProject(target);
  useTabStore.getState().switchProject(target.name);
  // `provider/session` as in a chat URL; without the provider the tab would open as Claude.
  if (sessionId) {
    autoOpenFromUrl("chat", providerId ? `${providerId}/${sessionId}` : sessionId, target.name);
    return;
  }
  const state = notifiedTab(url);
  if (state?.tabType && state.projectName === target.name) autoOpenFromUrl(state.tabType, state.tabIdentifier, target.name);
}

function notifiedTab(url: string): ReturnType<typeof parseUrlState> | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin ? parseUrlState(parsed) : null;
  } catch {
    return null;
  }
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
      void openNotifiedSession(message.project ?? "", message.sessionId ?? "", message.providerId ?? "", message.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
