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
  /** Broadcast notification to all channels (push, telegram). Fire-and-forget. */
  async broadcast(_type: NotificationType, payload: NotificationPayload): Promise<void> {
    const tasks: Promise<void>[] = [];
    const userOnline = hasActiveClient();

    // Push notifications — always send (works as ambient alert)
    tasks.push(
      import("./push-notification.service.ts")
        .then(({ pushService }) => pushService.notifyAll(payload.title, payload.body))
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
