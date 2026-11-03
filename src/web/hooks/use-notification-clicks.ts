import { useEffect, useRef } from "react";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage } from "../../shared/web-push-payload";

/**
 * A click on a push notification, handed over by the service worker to this window
 * (it focuses the window itself). Signed out, the page goes to the notification's URL,
 * which opens the session once signed in. Signed in, the notification's session is shown
 * here the way a `?openChat=` link opens it at boot; a notification about something other
 * than a chat (a design a reviewer commented on) opens the tab its URL names.
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
      void openSessionAnywhere(message.project ?? "", message.sessionId ?? "", message.providerId ?? "", message.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
