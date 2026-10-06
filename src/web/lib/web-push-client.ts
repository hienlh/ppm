/**
 * Push in this browser: the subscription the service worker holds, and the server's
 * record of it. Notifications arrive in `sw.ts`.
 */
import { api } from "@/lib/api-client";
import type { PushDeviceInfo } from "../../shared/notification-settings";
import {
  PUSH_BLOCKED_MESSAGE,
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLabelFrom,
  isIosDevice,
  pushSupportFrom,
  type PushSupport,
} from "./web-push-support";

function ipadOs(): boolean {
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function pushSupport(): PushSupport {
  return pushSupportFrom({
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    ios: isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    standalone: window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    permission: "Notification" in window ? Notification.permission : null,
  });
}

export function thisDeviceLabel(): string {
  return deviceLabelFrom(navigator.userAgent, ipadOs());
}

/** This browser's subscription, if it has one. Never prompts. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport().state === "unavailable") return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Made against `publicKey`. One made against an older key is refused by the push service. */
export function subscribedWithKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  return !!key && bytesToBase64Url(new Uint8Array(key)) === publicKey;
}

/**
 * Turn push on here. Call it straight from the click: Safari shows the permission
 * prompt only during a user gesture, so nothing is awaited before asking.
 */
export async function enablePush(publicKey: string): Promise<PushDeviceInfo> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? PUSH_BLOCKED_MESSAGE : "Notifications were not allowed.");
  }
  // Absent under `bun dev:web`, which registers no worker; `ready` would then wait forever.
  if (!(await navigator.serviceWorker.getRegistration())) {
    throw new Error("PPM's service worker is not running on this page, so it cannot receive push.");
  }
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscribedWithKey(subscription, publicKey)) {
    await api.post("/api/notifications/push/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  return api.post<PushDeviceInfo>("/api/notifications/push/subscribe", {
    subscription: subscription.toJSON(),
    label: thisDeviceLabel(),
    origin: window.location.origin,
  });
}

/** Turn push off here: the server forgets this browser, and the browser drops the subscription. */
export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  try {
    await api.post("/api/notifications/push/unsubscribe", { endpoint: subscription.endpoint });
  } finally {
    await subscription.unsubscribe();
  }
}
