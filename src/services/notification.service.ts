import { hasActiveClient } from "../server/ws/chat.ts";

export type NotificationType = "done" | "approval_request" | "question";

export interface NotificationPayload {
  title: string;
  body: string;
  project: string;
  sessionId: string;
  sessionTitle?: string;
  tool?: string;
  deviceName?: string;
}

class NotificationService {
  /** Broadcast event to all connected WebSocket clients */
  async broadcastWs(event: unknown): Promise<void> {
    const { broadcastGlobalEvent } = await import("../server/ws/chat.ts");
    broadcastGlobalEvent(event);
  }

  /** Broadcast notification to all channels (cloud push, telegram). Fire-and-forget. */
  async broadcast(type: NotificationType, payload: NotificationPayload): Promise<void> {
    const tasks: Promise<void>[] = [];
    const userOnline = hasActiveClient();

    // Cloud Push (replaces local Web Push) — Cloud dispatches to all subscribed browsers
    tasks.push(
      import("./cloud-ws.service.ts")
        .then(({ sendNotification }) => {
          sendNotification({
            title: payload.title,
            body: payload.body,
            project: payload.project,
            sessionId: payload.sessionId,
            sessionTitle: payload.sessionTitle,
            notificationType: type,
          });
        })
        .catch(() => {}),
    );

    // Telegram — only when user has no active browser session
    if (!userOnline) {
      tasks.push(
        import("./telegram-notification.service.ts")
          .then(({ telegramService }) => telegramService.send(payload))
          .catch(() => {}),
      );
    }

    await Promise.allSettled(tasks);
  }
}

/** Singleton notification dispatcher */
export const notificationService = new NotificationService();
