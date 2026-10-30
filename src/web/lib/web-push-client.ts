/**
 * Push in this browser: the subscription the service worker holds, and the server's
 * record of it. Notifications arrive in `sw.ts`.
 */
import { api } from "@/lib/api-client";
import type { PushDeviceInfo } from "../../shared/notification-settings";
import {
  PUSH_BLOCKED_MESSAGE,
  PUSH_SUBSCRIBE_DEADLINE_MS,
  base64UrlToBytes,
  browserNameFrom,
  bytesToBase64Url,
  deviceLabelFrom,
  isIosDevice,
  pushServiceFailureMessage,
  pushSupportFrom,
  withinDeadline,
  type PushSupport,
} from "./web-push-support";

function ipadOs(): boolean {
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

/**
 * The browser a push failure names. Brave says "Chrome" in its user agent; Vivaldi and Chromium
 * do too, but list no Chrome brand, so they get "This browser" rather than a guess.
 * `userAgentData` exists only in a secure context, and so does every use of this answer:
 * `pushSupportFrom` stops at plain HTTP before it reads the browser.
 */
function thisBrowser(): string {
  if ("brave" in navigator) return "Brave";
  const name = browserNameFrom(navigator.userAgent);
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands;
  if (name === "Chrome" && brands && !brands.some((b) => b.brand === "Google Chrome")) return "Browser";
  return name;
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
    browser: thisBrowser(),
  });
}

/**
 * Not `thisBrowser()`: a device list wants a name the user recognises, so a Chromium build with
 * no Chrome brand (Vivaldi, Chromium) stays "Chrome" here. A push failure names the browser's
 * push service, and there a wrong guess sends the user after the wrong one.
 */
export function thisDeviceLabel(): string {
  return deviceLabelFrom(navigator.userAgent, ipadOs(), "brave" in navigator ? "Brave" : undefined);
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
  try {
    subscription ??= await withinDeadline(registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }), PUSH_SUBSCRIBE_DEADLINE_MS);
  } catch (e) {
    const hint = pushServiceFailureMessage(thisBrowser(), e);
    if (hint) throw new Error(hint);
    throw e;
  }
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
