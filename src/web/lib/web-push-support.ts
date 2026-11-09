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
  /** `browserNameFrom`, or "Brave". */
  browser?: string;
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
    // Firefox hides PushManager, and nothing else, when `dom.push.enabled` is false.
    if (env.browser === "Firefox" && env.serviceWorker && env.notification) {
      return {
        state: "unavailable",
        message: "Push is turned off in this browser. Open about:config, set dom.push.enabled to true, then restart the browser.",
      };
    }
    return { state: "unavailable", message: "This browser cannot receive push notifications." };
  }
  if (env.permission === "denied") return { state: "blocked", message: PUSH_BLOCKED_MESSAGE };
  return { state: "available" };
}

/**
 * The first subscribe after a browser starts took ~30 s in Chrome and Brave (3 s once
 * running). A push service the network blocks may never answer: with Google's hosts
 * unresolvable, Chrome kept retrying for minutes and never rejected.
 */
export const PUSH_SUBSCRIBE_DEADLINE_MS = 60_000;

export function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DOMException("The push service did not answer.", "TimeoutError")), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Whose push service each browser registers with, where that is the same on every platform. */
const PUSH_SERVICE_OWNER: Record<string, string> = { Brave: "Google", Chrome: "Google", Firefox: "Mozilla", Safari: "Apple" };

/**
 * What to do when `pushManager.subscribe` fails because of the push service, or null for
 * any other failure. A browser reports a service it cannot use as an AbortError.
 */
export function pushServiceFailureMessage(browser: string, error: unknown): string | null {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  if (name !== "AbortError" && name !== "TimeoutError") return null;
  // Brave turns Google's push service off by default and rejects at once.
  if (browser === "Brave" && name === "AbortError") {
    return "Brave keeps push off until you allow it: open brave://settings/privacy, turn on “Use Google services for push messaging”, restart Brave, then turn this on again.";
  }
  const owner = PUSH_SERVICE_OWNER[browser];
  const service = owner ? `${owner}'s push service` : "its push service";
  const failed = name === "TimeoutError" ? `got no answer from ${service} within a minute` : `could not register with ${service}`;
  const said = name === "AbortError" && typeof message === "string" && message ? ` (${message})` : "";
  return `${browser === "Browser" ? "This browser" : browser} ${failed}${said}. `
    + `A firewall, VPN, DNS filter or ad blocker may be blocking it${owner ? "" : ", or push is turned off in this browser"}. `
    + "Telegram and ntfy below work without it.";
}

/** iPadOS reports itself as a Mac; a Mac has no touch screen. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** Brave and most other Chromium builds say "Chrome"; the user agent cannot tell them apart. */
export function browserNameFrom(userAgent: string): string {
  return /Edg(A|iOS)?\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
    : /SamsungBrowser\//.test(userAgent) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(userAgent) ? "Firefox"
    : /Chrome\/|CriOS\//.test(userAgent) ? "Chrome"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";
}

/**
 * "Chrome on Android" — enough to tell a phone from a laptop in the list. `browser` is for
 * what the user agent cannot say: Brave's is Chrome's.
 */
export function deviceLabelFrom(userAgent: string, ipadOs = false, browser = browserNameFrom(userAgent)): string {
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
