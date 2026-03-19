import webpush from "web-push";
import { configService } from "./config.service.ts";
import type { PushConfig } from "../types/config.ts";
import {
  getPushSubscriptions,
  upsertPushSubscription,
  deletePushSubscription,
} from "./db.service.ts";

interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

class PushNotificationService {
  private initialized = false;

  /** Initialize VAPID keys — auto-generate if missing */
  init(): void {
    if (this.initialized) return;

    let push = configService.get("push") as PushConfig | undefined;
    if (!push?.vapid_public_key || !push?.vapid_private_key) {
      const keys = webpush.generateVAPIDKeys();
      push = {
        vapid_public_key: keys.publicKey,
        vapid_private_key: keys.privateKey,
        vapid_subject: "https://ppm.local",
      };
      configService.set("push", push);
      configService.save();
      console.log("[push] VAPID keys generated and saved to config");
    }

    webpush.setVapidDetails(
      push.vapid_subject,
      push.vapid_public_key,
      push.vapid_private_key,
    );
    this.initialized = true;
  }

  /** Get VAPID public key for frontend subscription */
  getVapidPublicKey(): string {
    this.init();
    const push = configService.get("push") as PushConfig | undefined;
    return push?.vapid_public_key ?? "";
  }

  /** Save a new push subscription */
  saveSubscription(sub: PushSubscriptionData): void {
    upsertPushSubscription(
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      sub.expirationTime != null ? String(sub.expirationTime) : null,
    );
  }

  /** Remove a push subscription by endpoint */
  removeSubscription(endpoint: string): void {
    deletePushSubscription(endpoint);
  }

  /** Send push notification to all subscriptions (fire-and-forget) */
  async notifyAll(title: string, body: string): Promise<void> {
    this.init();
    const dbSubs = getPushSubscriptions();
    if (dbSubs.length === 0) return;

    const payload = JSON.stringify({ title, body });
    const expired: string[] = [];

    const subs: PushSubscriptionData[] = dbSubs.map((r) => ({
      endpoint: r.endpoint,
      keys: { p256dh: r.p256dh, auth: r.auth },
      expirationTime: r.expiration_time ? Number(r.expiration_time) : null,
    }));

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (error: unknown) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            expired.push(sub.endpoint);
          }
        }
      }),
    );

    for (const endpoint of expired) {
      deletePushSubscription(endpoint);
    }
    if (expired.length > 0) {
      console.log(`[push] Removed ${expired.length} expired subscriptions`);
    }
  }
}

/** Singleton push notification service */
export const pushService = new PushNotificationService();
