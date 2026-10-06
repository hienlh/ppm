/**
 * Sends Web Push notifications to every browser that turned push on.
 *
 * Standard Web Push, not the Firebase SDK: the browser picks the push service
 * (Chrome and Android deliver through FCM, Firefox through Mozilla's, Safari through
 * Apple's), PPM signs each request with its own VAPID key, and nobody needs a
 * Firebase project. Push needs a secure origin, so a browser can only subscribe from
 * PPM reached over HTTPS or on localhost.
 */
import type { PushDeviceInfo } from "../../shared/notification-settings.ts";
import type { WebPushPayload } from "../../shared/web-push-payload.ts";
import { base64UrlDecode, encryptPushPayload, vapidAuthorization } from "./web-push-crypto.ts";
import {
  getVapidKeys,
  listSubscriptions,
  removeSubscription,
  updateSubscription,
  upsertSubscription,
  type StoredSubscription,
} from "./web-push-store.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("web-push");

/** Who push services may contact about this sender. RFC 8292 asks for a mailto: or https: URL. */
const VAPID_SUBJECT = "https://github.com/hienlh/ppm";
/** How long a push service keeps trying a phone that is offline. Older than this, the news is stale. */
const TTL_SECONDS = 12 * 3600;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ENDPOINT_LENGTH = 2048;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the service worker gets. `url` is absolute; the worker decides whether it is its own origin. */
export interface PushMessage {
  title: string;
  body: string;
  /** Path inside PPM to open on click, e.g. `/project/ppm?openChat=<id>`. */
  path: string;
  tag: string;
  project: string;
  sessionId: string;
  /** "" when unknown. */
  providerId: string;
  urgency: "high" | "normal";
}

export interface PushSendResult {
  sent: number;
  failed: number;
  removed: number;
}

function decodedLength(value: string): number {
  try {
    return base64UrlDecode(value).length;
  } catch {
    return -1;
  }
}

/** Check what a browser posted before anything is stored or ever fetched. */
export function parsePushSubscription(body: unknown): { ok: true; value: PushSubscriptionInput } | { ok: false; error: string } {
  const sub = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > MAX_ENDPOINT_LENGTH) {
    return { ok: false, error: "Missing push endpoint" };
  }
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return { ok: false, error: "Push endpoint is not a URL" };
  }
  // Every push service is HTTPS. Anything else is not a push service, and the server
  // would be POSTing wherever a client told it to.
  if (url.protocol !== "https:") return { ok: false, error: "Push endpoint must be https" };
  const p256dh = sub.keys?.p256dh;
  const auth = sub.keys?.auth;
  if (typeof p256dh !== "string" || decodedLength(p256dh) !== 65 || base64UrlDecode(p256dh)[0] !== 0x04) {
    return { ok: false, error: "Invalid p256dh key" };
  }
  if (typeof auth !== "string" || decodedLength(auth) !== 16) return { ok: false, error: "Invalid auth secret" };
  return { ok: true, value: { endpoint: sub.endpoint, keys: { p256dh, auth } } };
}

/**
 * The URL a click opens, for a browser that subscribed from `origin`.
 *
 * A quick tunnel gets a new hostname on every start, so a subscription made through
 * one would open a dead page after a restart: those are pointed at today's tunnel.
 * Every other origin — localhost, a named tunnel, a Tailscale name — is stable.
 */
export function pushTargetUrl(origin: string, path: string, currentTunnelUrl: string | null): string {
  try {
    const from = new URL(origin);
    if (from.hostname.endsWith(".trycloudflare.com") && currentTunnelUrl) {
      const current = new URL(currentTunnelUrl);
      if (current.origin !== from.origin) return new URL(path, current).href;
    }
    return new URL(path, from).href;
  } catch {
    return path;
  }
}

function toDeviceInfo(s: StoredSubscription): PushDeviceInfo {
  return {
    id: s.id,
    label: s.label,
    endpoint: s.endpoint,
    origin: s.origin,
    createdAt: s.createdAt,
    lastSuccessAt: s.lastSuccessAt,
    lastError: s.lastError,
  };
}

async function currentTunnelUrl(): Promise<string | null> {
  try {
    const { tunnelService } = await import("../tunnel.service.ts");
    return tunnelService.getTunnelUrl();
  } catch {
    return null;
  }
}

class WebPushService {
  async publicKey(): Promise<string> {
    return (await getVapidKeys()).publicKey;
  }

  devices(): PushDeviceInfo[] {
    return listSubscriptions().map(toDeviceInfo);
  }

  async subscribe(input: PushSubscriptionInput, label: string, origin: string): Promise<PushDeviceInfo> {
    const { publicKey } = await getVapidKeys();
    const record = upsertSubscription({
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      label: label.trim().slice(0, 80) || "Browser",
      origin,
      vapidKey: publicKey,
    });
    log.info(`Subscription saved: device "${record.label}" id=${record.id}`);
    return toDeviceInfo(record);
  }

  unsubscribe(match: { id?: string; endpoint?: string }): boolean {
    const removed = removeSubscription(match);
    if (removed) log.info(`Subscription removed on request${match.id ? `: id=${match.id}` : ""}`);
    return removed;
  }

  /** Send to every subscribed browser, or only those `filter` keeps. Never throws. */
  async send(message: PushMessage, filter?: (device: PushDeviceInfo) => boolean): Promise<PushSendResult> {
    const result: PushSendResult = { sent: 0, failed: 0, removed: 0 };
    const targets = listSubscriptions().filter((s) => !filter || filter(toDeviceInfo(s)));
    if (targets.length === 0) return result;

    const keys = await getVapidKeys();
    const tunnelUrl = await currentTunnelUrl();
    await Promise.allSettled(targets.map(async (sub) => {
      const outcome = await this.deliver(sub, message, keys, tunnelUrl);
      result[outcome]++;
    }));
    return result;
  }

  private async deliver(
    sub: StoredSubscription,
    message: PushMessage,
    keys: Awaited<ReturnType<typeof getVapidKeys>>,
    tunnelUrl: string | null,
  ): Promise<keyof PushSendResult> {
    if (sub.vapidKey !== keys.publicKey) {
      // The push service would refuse it (403). Opening PPM on that device subscribes it again.
      const lastError = "Subscribed with an old key — turn push on again on that device";
      // Every failure below is logged when it changes: the error stored last time says whether it did.
      if (sub.lastError !== lastError) log.warn(`Device "${sub.label}" id=${sub.id} subscribed with an old VAPID key — skipped until it subscribes again`);
      updateSubscription(sub.id, { lastError });
      return "failed";
    }
    try {
      const payload = new TextEncoder().encode(JSON.stringify({
        title: message.title,
        body: message.body,
        url: pushTargetUrl(sub.origin, message.path, tunnelUrl),
        tag: message.tag,
        project: message.project,
        sessionId: message.sessionId,
        providerId: message.providerId,
      } satisfies WebPushPayload));
      const body = await encryptPushPayload(payload, base64UrlDecode(sub.p256dh), base64UrlDecode(sub.auth));
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          TTL: String(TTL_SECONDS),
          Urgency: message.urgency,
          Authorization: await vapidAuthorization(sub.endpoint, keys, VAPID_SUBJECT),
        },
        body,
        // A push service answers a push itself. Following a redirect would re-send it to an
        // address the https check in parsePushSubscription never saw.
        redirect: "manual",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // 404/410: the browser unsubscribed or the subscription expired. It will never work again.
      if (res.status === 404 || res.status === 410) {
        removeSubscription({ id: sub.id });
        log.info(`Subscription removed (HTTP ${res.status}): device "${sub.label}" id=${sub.id}`);
        return "removed";
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).trim().slice(0, 200);
        const lastError = `${res.status}${text ? ` ${text}` : ""}`;
        updateSubscription(sub.id, { lastError });
        if (sub.lastError !== lastError) log.warn(`Device "${sub.label}" id=${sub.id}: push service answered ${lastError}`);
        else log.debug(`Device "${sub.label}" id=${sub.id}: push service answered ${res.status} again`);
        return "failed";
      }
      updateSubscription(sub.id, { lastSuccessAt: Date.now(), lastError: null });
      return "sent";
    } catch (e) {
      const msg = (e as Error).message;
      updateSubscription(sub.id, { lastError: msg.slice(0, 200) });
      if (sub.lastError !== msg.slice(0, 200)) log.warn(`Device "${sub.label}" id=${sub.id}: ${msg}`);
      else log.debug(`Device "${sub.label}" id=${sub.id}: ${msg} (again)`);
      return "failed";
    }
  }
}

export const webPushService = new WebPushService();
