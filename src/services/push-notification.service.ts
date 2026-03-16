import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { configService } from "./config.service.ts";
import type { PushConfig } from "../types/config.ts";

const SUBS_PATH = resolve(homedir(), ".ppm", "push-subscriptions.json");

interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

/** Load subscriptions from disk */
function loadSubscriptions(): PushSubscriptionData[] {
  try {
    if (existsSync(SUBS_PATH)) {
      return JSON.parse(readFileSync(SUBS_PATH, "utf-8"));
    }
  } catch { /* corrupt file — start fresh */ }
  return [];
}

/** Save subscriptions to disk */
function saveSubscriptions(subs: PushSubscriptionData[]): void {
  const dir = dirname(SUBS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SUBS_PATH, JSON.stringify(subs, null, 2), "utf-8");
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
    const subs = loadSubscriptions();
    // Deduplicate by endpoint
    const filtered = subs.filter((s) => s.endpoint !== sub.endpoint);
    filtered.push(sub);
    saveSubscriptions(filtered);
  }

  /** Remove a push subscription by endpoint */
  removeSubscription(endpoint: string): void {
    const subs = loadSubscriptions();
    saveSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
  }

  /** Send push notification to all subscriptions (fire-and-forget) */
  async notifyAll(title: string, body: string): Promise<void> {
    this.init();
    const subs = loadSubscriptions();
    if (subs.length === 0) return;

    const payload = JSON.stringify({ title, body });
    const expired: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (error: unknown) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          // 404 or 410 = subscription expired/invalid — mark for removal
          if (statusCode === 410 || statusCode === 404) {
            expired.push(sub.endpoint);
          }
        }
      }),
    );

    // Auto-cleanup expired subscriptions
    if (expired.length > 0) {
      const remaining = loadSubscriptions().filter(
        (s) => !expired.includes(s.endpoint),
      );
      saveSubscriptions(remaining);
      console.log(`[push] Removed ${expired.length} expired subscriptions`);
    }
  }
}

/** Singleton push notification service */
export const pushService = new PushNotificationService();
