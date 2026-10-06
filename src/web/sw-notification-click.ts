/**
 * Where a click on a push notification goes. Its own module so it runs under `bun:test`
 * with stand-in clients; `sw.ts` passes the real `self.clients`.
 */
import { OPEN_FROM_NOTIFICATION, type OpenFromNotificationMessage, type WebPushPayload } from "../shared/web-push-payload";

export interface NotificationWindow {
  focused: boolean;
  visibilityState: DocumentVisibilityState;
  postMessage(message: unknown): void;
  focus(): Promise<unknown>;
}

export interface NotificationClients {
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly NotificationWindow[]>;
  openWindow(url: string): Promise<unknown>;
}

/**
 * Into a PPM window that is already open when there is one: it is told which session
 * to show, so the app opens it the way the notification bell does — no reload, nothing
 * it was doing lost. Only without such a window is a new one opened.
 */
export async function routeNotificationClick(
  push: WebPushPayload,
  clients: NotificationClients,
  workerOrigin: string,
): Promise<void> {
  const target = new URL(push.url, workerOrigin);
  // A notification can name another origin: a device that subscribed on an old quick
  // tunnel is sent the current one. A window here cannot show that.
  if (target.origin === workerOrigin) {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((c) => c.focused)
      ?? windows.find((c) => c.visibilityState === "visible")
      ?? windows[0];
    if (client) {
      const message: OpenFromNotificationMessage = {
        type: OPEN_FROM_NOTIFICATION,
        url: target.href,
        project: push.project,
        sessionId: push.sessionId,
        providerId: push.providerId,
      };
      client.postMessage(message);
      await client.focus().catch(() => undefined);
      return;
    }
  }
  await clients.openWindow(target.href);
}
