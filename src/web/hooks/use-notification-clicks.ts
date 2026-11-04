import { useEffect, useRef } from "react";
import { ppmUrlState, showProjectTab } from "@/lib/open-ppm-tab";
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage } from "../../shared/web-push-payload";

/**
 * Show a notification's session in this window, the way a `?openChat=` link opens it at boot.
 * A notification about something other than a chat (a design a reviewer commented on) opens
 * the tab its URL names, as that URL would at boot.
 */
async function openNotifiedSession(projectName: string, sessionId: string, providerId: string, url: string): Promise<void> {
  // `provider/session` as in a chat URL; without the provider the tab would open as Claude.
  if (sessionId) {
    await showProjectTab(projectName, "chat", providerId ? `${providerId}/${sessionId}` : sessionId);
    return;
  }
  const state = ppmUrlState(url);
  await showProjectTab(projectName, state?.projectName === projectName ? state.tabType : null, state?.tabIdentifier ?? null);
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
