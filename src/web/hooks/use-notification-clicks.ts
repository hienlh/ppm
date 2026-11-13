import { useEffect, useRef } from "react";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import { showProjectTab } from "@/lib/open-ppm-tab";
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage } from "../../shared/web-push-payload";
import { parseExtensionDeepLink, type ParsedExtensionDeepLink } from "../../shared/extension-deep-link";
import { runExtensionDeepLink } from "@/lib/extension-deep-link-runner";

/**
 * An extension's link (its own command or panel): open the project it is scoped to, if any,
 * then run it here, so the panel gets a tab on the device that was tapped.
 */
async function openNotifiedExtensionLink(link: ParsedExtensionDeepLink): Promise<void> {
  if (link.projectName && !(await showProjectTab(link.projectName, null, null))) return;
  await runExtensionDeepLink(link);
}

function sameOriginDeepLink(url: string): ParsedExtensionDeepLink | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin ? parseExtensionDeepLink(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * A click on a push notification, handed over by the service worker to this window
 * (it focuses the window itself). Signed out, the page goes to the notification's URL,
 * which opens the session once signed in. Signed in, the notification's session is shown
 * here the way a `?openChat=` link opens it at boot (an Assistant session in the Assistant);
 * a notification about something other than a chat (a design a reviewer commented on) opens
 * the tab its URL names.
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
      const link = sameOriginDeepLink(message.url);
      if (link) {
        void openNotifiedExtensionLink(link);
        return;
      }
      void openSessionAnywhere(message.project ?? "", message.sessionId ?? "", message.providerId ?? "", message.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
