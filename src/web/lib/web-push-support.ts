/**
 * Whether this browser can take push, and what to call it in the device list.
 *
 * Pure, so it runs under `bun:test`: `web-push-client.ts` gathers the facts from
 * `window`/`navigator` and these decide.
 */

export interface PushEnvironment {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  /** Opened from the Home Screen rather than in a browser tab. */
  standalone: boolean;
  permission: NotificationPermission | null;
}

export type PushSupport =
  | { state: "available" }
  | { state: "blocked"; message: string }
  | { state: "unavailable"; message: string };

export const PUSH_BLOCKED_MESSAGE =
  "Notifications are blocked for this site. Allow them in the browser's site settings, then turn this on again.";

export function pushSupportFrom(env: PushEnvironment): PushSupport {
  // First: on plain HTTP the push APIs are missing too, and this is the reason to act on.
  if (!env.secure) {
    return {
      state: "unavailable",
      message: "Push needs PPM on HTTPS or localhost. Browsers turn it off on a plain HTTP address like this one.",
    };
  }
  // iOS exposes push only to a web app opened from the Home Screen; in a Safari tab the API is absent.
  if (env.ios && !env.standalone) {
    return {
      state: "unavailable",
      message: "On iPhone and iPad, push works only in PPM added to the Home Screen: tap Share → Add to Home Screen, open PPM from there, then turn this on.",
    };
  }
  if (!env.serviceWorker || !env.pushManager || !env.notification) {
    return { state: "unavailable", message: "This browser cannot receive push notifications." };
  }
  if (env.permission === "denied") return { state: "blocked", message: PUSH_BLOCKED_MESSAGE };
  return { state: "available" };
}

/** iPadOS reports itself as a Mac; a Mac has no touch screen. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** "Chrome on Android" — enough to tell a phone from a laptop in the list. */
export function deviceLabelFrom(userAgent: string, ipadOs = false): string {
  const browser =
    /Edg(A|iOS)?\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
    : /SamsungBrowser\//.test(userAgent) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";
  const os =
    /Android/.test(userAgent) ? "Android"
    : /iPhone|iPod/.test(userAgent) ? "iPhone"
    : /iPad/.test(userAgent) || ipadOs ? "iPad"
    : /Mac OS X/.test(userAgent) ? "macOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /CrOS/.test(userAgent) ? "ChromeOS"
    : /Linux/.test(userAgent) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
