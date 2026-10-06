import { configService } from "./config.service.ts";
import { getSessionProvider } from "./db.service.ts";
import { resolveNotificationSettings, type NotificationEvent } from "../shared/notification-settings.ts";
import { formatPushNotification, notificationPath } from "./notification-format.ts";
import type { NtfyConfig } from "../types/config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("notify");

export type NotificationType = NotificationEvent;

export interface NotificationPayload {
  title: string;
  body: string;
  /** Project NAME, never its path — links resolve projects by name. "" when there is none. */
  project: string;
  /** "" when the event belongs to no session. */
  sessionId: string;
  /** The session's provider, so a link opens it in the right kind of chat. Looked up when absent. */
  providerId?: string;
  sessionTitle?: string;
  tool?: string;
  /** Worth reading without opening PPM: the answer's opening, the command awaiting approval, the question. */
  detail?: string;
  /** How Telegram shows `detail`: quoted prose, or a code block for commands and paths. */
  detailStyle?: "quote" | "code";
  deviceName?: string;
}

export interface BroadcastOptions {
  /**
   * Asked once the delay is over. False means someone opened the session or answered
   * the prompt meanwhile, so nothing is sent. Without it the notification always goes
   * out: schedules and Jira have no "seen" state.
   */
  stillUnseen?: () => boolean;
}

const URGENT: ReadonlySet<NotificationType> = new Set(["approval_request", "question"]);

export class NotificationService {
  /** At most one waiting notification per session: a newer event about it replaces the older one. */
  private pending = new Map<string, () => void>();

  /** @param msPerSecond test seam — the delay setting is in seconds. */
  constructor(private readonly msPerSecond = 1000) {}

  /** Broadcast event to all connected WebSocket clients */
  async broadcastWs(event: unknown): Promise<void> {
    const { broadcastGlobalEvent } = await import("../server/ws/chat.ts");
    broadcastGlobalEvent(event);
  }

  /**
   * Notify on every enabled channel: after the configured delay, and only if it is still
   * unseen by then. Resolves once delivered or dropped — callers do not wait on it.
   *
   * The old rule was "send to Telegram only while no browser is connected", which meant
   * never: a PPM tab left open anywhere, even in the background, kept it silent.
   */
  broadcast(type: NotificationType, payload: NotificationPayload, opts: BroadcastOptions = {}): Promise<void> {
    const settings = resolveNotificationSettings(configService.get("notifications"));
    if (!settings.events[type]) {
      log.debug(`Notification ${type} not sent: switched off`);
      return Promise.resolve();
    }
    if (settings.delay_seconds === 0) return this.deliver(type, payload);

    const key = payload.sessionId || null;
    if (key) this.pending.get(key)?.();
    return new Promise<void>((resolve) => {
      const cancel = () => {
        clearTimeout(timer);
        if (key && this.pending.get(key) === cancel) this.pending.delete(key);
        log.debug(`Notification ${type} session=${key} not sent: replaced by a newer one`);
        resolve();
      };
      const timer = setTimeout(() => {
        if (key && this.pending.get(key) === cancel) this.pending.delete(key);
        let unseen = true;
        try {
          unseen = opts.stillUnseen ? opts.stillUnseen() : true;
        } catch { /* cannot tell — better one notification too many than a missed approval */ }
        if (!unseen) {
          log.debug(`Notification ${type} session=${key ?? "-"} not sent: seen within ${settings.delay_seconds}s`);
          return resolve();
        }
        this.deliver(type, payload).finally(resolve);
      }, settings.delay_seconds * this.msPerSecond);
      if (key) this.pending.set(key, cancel);
    });
  }

  private async deliver(type: NotificationType, event: NotificationPayload): Promise<void> {
    const settings = resolveNotificationSettings(configService.get("notifications"));
    const payload: NotificationPayload = { ...event, providerId: event.providerId || providerOf(event.sessionId) };
    const deviceName = (configService.get("device_name") as string) || "PPM";
    const tasks: Promise<unknown>[] = [];
    // What each channel did, logged as one line once all have answered — never the title or the body.
    const outcome = { push: "", telegram: "off", ntfy: "off" };

    // PPM Cloud. Its connection lives in the supervisor, not in this process, so today this
    // only fills cloud-ws's bounded queue; kept so wiring Cloud up needs no change here.
    tasks.push(
      import("./cloud-ws.service.ts")
        .then(({ sendNotification }) => {
          sendNotification({
            title: payload.title,
            body: payload.body,
            project: payload.project,
            sessionId: payload.sessionId,
            sessionTitle: payload.sessionTitle,
            notificationType: type === "schedule" || type === "jira" ? "done" : type,
          });
        })
        .catch(() => {}),
    );

    tasks.push(
      import("./web-push/web-push.service.ts")
        .then(({ webPushService }) => {
          const { title, body } = formatPushNotification(payload, deviceName);
          return webPushService.send({
            title,
            body,
            path: notificationPath(payload),
            // Same tag = the newer notification replaces the older one on the device. Right for a
            // session; wrong for two Jira hits that land in the same millisecond.
            tag: payload.sessionId ? `ppm-${payload.sessionId}` : `ppm-${type}-${crypto.randomUUID()}`,
            project: payload.project,
            sessionId: payload.sessionId,
            providerId: payload.providerId ?? "",
            urgency: URGENT.has(type) ? "high" : "normal",
          });
        })
        .then((r) => { outcome.push = `sent=${r.sent} failed=${r.failed} removed=${r.removed}`; })
        .catch((e) => {
          outcome.push = "failed";
          log.warn(`push failed: ${(e as Error).message}`);
        }),
    );

    if (settings.telegram) {
      tasks.push(
        import("./telegram-notification.service.ts")
          .then(({ telegramService }) => telegramService.send(payload))
          .then((result) => { outcome.telegram = result; })
          .catch((e) => {
            outcome.telegram = "failed";
            log.warn(`telegram failed: ${(e as Error).message}`);
          }),
      );
    }

    if (settings.ntfy) {
      let ntfy: NtfyConfig | null = null;
      tasks.push(
        import("./ntfy-notification.service.ts")
          .then(({ ntfyService, savedNtfyConfig }) => {
            ntfy = savedNtfyConfig();
            return ntfyService.send(payload, URGENT.has(type));
          })
          .then(() => { outcome.ntfy = ntfy ? "sent" : "not set up"; })
          .catch((e) => {
            outcome.ntfy = "failed";
            log.warn(`ntfy failed: ${ntfyFailure(e, ntfy)}`);
          }),
      );
    }

    await Promise.allSettled(tasks);
    log.info(`Notification ${type} session=${payload.sessionId || "-"} → push ${outcome.push}, telegram ${outcome.telegram}, ntfy ${outcome.ntfy}`);
  }
}

/**
 * An ntfy failure as it may be logged. On a public server the topic is the shared secret —
 * whoever knows it reads every notification — and ntfy's refusals name it, so it is cut out,
 * and the server is reduced to its host.
 */
function ntfyFailure(e: unknown, config: NtfyConfig | null): string {
  const msg = (e as Error).message;
  if (!config) return msg;
  let host = config.server;
  try {
    host = new URL(config.server).host;
  } catch { /* not a URL: keep it as typed */ }
  return msg.split(config.server).join(host).split(config.topic).join("[topic]");
}

/** Sessions PPM created or resumed have their provider recorded; others have no row. */
function providerOf(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    return getSessionProvider(sessionId) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Singleton notification dispatcher */
export const notificationService = new NotificationService();
