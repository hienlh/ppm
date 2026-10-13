import { describe, expect, it } from "bun:test";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLabelFrom,
  isIosDevice,
  pushServiceFailureMessage,
  pushSupportFrom,
  withinDeadline,
  type PushEnvironment,
} from "../../../src/web/lib/web-push-support.ts";
import { routeNotificationClick, type NotificationWindow } from "../../../src/web/sw-notification-click.ts";
import { OPEN_FROM_NOTIFICATION, readWebPushPayload } from "../../../src/shared/web-push-payload.ts";
import { base64UrlEncode } from "../../../src/services/web-push/web-push-crypto.ts";

const capable: PushEnvironment = {
  secure: true, serviceWorker: true, pushManager: true, notification: true, ios: false, standalone: false, permission: "default",
};

describe("pushSupportFrom", () => {
  it("offers push in a capable browser, permission not yet asked", () => {
    expect(pushSupportFrom(capable)).toEqual({ state: "available" });
  });

  it("names plain HTTP as the reason, even though the APIs are missing there too", () => {
    const support = pushSupportFrom({ ...capable, secure: false, pushManager: false, serviceWorker: false });
    expect(support.state).toBe("unavailable");
    expect(support.state !== "available" && support.message).toContain("HTTPS");
  });

  it("sends iPhone users to the Home Screen, and lets the installed app through", () => {
    const tab = pushSupportFrom({ ...capable, ios: true, pushManager: false });
    expect(tab.state !== "available" && tab.message).toContain("Home Screen");
    expect(pushSupportFrom({ ...capable, ios: true, standalone: true })).toEqual({ state: "available" });
  });

  it("tells a browser with no push apart from a blocked permission", () => {
    expect(pushSupportFrom({ ...capable, pushManager: false }).state).toBe("unavailable");
    expect(pushSupportFrom({ ...capable, permission: "denied" }).state).toBe("blocked");
  });

  // Measured on Firefox 157: dom.push.enabled = false removes PushManager and nothing else.
  it("sends Firefox with push switched off to about:config", () => {
    const off = pushSupportFrom({ ...capable, pushManager: false, browser: "Firefox" });
    expect(off.state !== "available" && off.message).toContain("dom.push.enabled");
    const chrome = pushSupportFrom({ ...capable, pushManager: false, browser: "Chrome" });
    expect(chrome.state !== "available" && chrome.message).toBe("This browser cannot receive push notifications.");
    // The setting hides PushManager alone; a Firefox missing more than that is not fixed by it.
    const noWorker = pushSupportFrom({ ...capable, pushManager: false, serviceWorker: false, browser: "Firefox" });
    expect(noWorker.state !== "available" && noWorker.message).toBe("This browser cannot receive push notifications.");
    const noNotification = pushSupportFrom({ ...capable, pushManager: false, notification: false, browser: "Firefox" });
    expect(noNotification.state !== "available" && noNotification.message).toBe("This browser cannot receive push notifications.");
  });
});

describe("pushServiceFailureMessage", () => {
  // What Brave 1.97 rejects with while "Use Google services for push messaging" is off.
  const refused = new DOMException("Registration failed - push service error", "AbortError");
  const silent = new DOMException("The push service did not answer.", "TimeoutError");

  it("walks Brave users to the setting that turns push on", () => {
    const message = pushServiceFailureMessage("Brave", refused);
    expect(message).toContain("brave://settings/privacy");
    expect(message).toContain("Use Google services for push messaging");
  });

  it("names the push service a browser could not register with", () => {
    expect(pushServiceFailureMessage("Chrome", refused))
      .toStartWith("Chrome could not register with Google's push service (Registration failed - push service error).");
    expect(pushServiceFailureMessage("Firefox", new DOMException("Error retrieving push subscription.", "AbortError")))
      .toContain("Mozilla's push service");
    const unknown = pushServiceFailureMessage("Browser", refused);
    expect(unknown).toStartWith("This browser could not register with its push service");
    expect(unknown).toContain("push is turned off in this browser");
  });

  it("explains a push service that never answered, in Brave too", () => {
    expect(pushServiceFailureMessage("Brave", silent)).toStartWith("Brave got no answer from Google's push service within a minute.");
    expect(pushServiceFailureMessage("Edge", silent)).toStartWith("Edge got no answer from its push service within a minute.");
  });

  it("leaves every other failure in the browser's own words", () => {
    expect(pushServiceFailureMessage("Brave", new DOMException("Registration failed - permission denied", "NotAllowedError"))).toBeNull();
    expect(pushServiceFailureMessage("Chrome", new TypeError("reg.pushManager is undefined"))).toBeNull();
    expect(pushServiceFailureMessage("Chrome", undefined)).toBeNull();
  });
});

describe("withinDeadline", () => {
  it("gives up on a push service that never answers", async () => {
    const error = await withinDeadline(new Promise(() => {}), 5).catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  it("passes the subscription through", async () => {
    expect(await withinDeadline(Promise.resolve("subscription"), 1000)).toBe("subscription");
  });
});

describe("deviceLabelFrom", () => {
  const cases: Array<[string, string]> = [
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
  ];
  for (const [ua, label] of cases) {
    it(label, () => expect(deviceLabelFrom(ua)).toBe(label));
  }

  it("calls an iPad an iPad although it says it is a Mac", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
    expect(isIosDevice(ua, "MacIntel", 5)).toBe(true);
    expect(isIosDevice(ua, "MacIntel", 0)).toBe(false);
    expect(deviceLabelFrom(ua, true)).toBe("Safari on iPad");
  });
});

describe("base64url", () => {
  it("decodes the server's VAPID key encoding and back", () => {
    const key = new Uint8Array(65).map((_, i) => (i * 37 + 4) & 0xff);
    const encoded = base64UrlEncode(key);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(key));
    expect(bytesToBase64Url(key)).toBe(encoded);
  });
});

describe("readWebPushPayload", () => {
  it("falls back to something showable for a body it cannot use", () => {
    expect(readWebPushPayload(null)).toEqual({ title: "PPM", body: "", url: "/", tag: "", project: "", sessionId: "", providerId: "" });
    expect(readWebPushPayload({ title: 7, body: "hi", sessionId: ["x"] })).toMatchObject({ title: "PPM", body: "hi", sessionId: "" });
  });
});

describe("routeNotificationClick", () => {
  const ORIGIN = "https://ppm.example";
  const push = readWebPushPayload({ url: `${ORIGIN}/project/ppm?openChat=codex%2Fs1`, project: "ppm", sessionId: "s1", providerId: "codex" });

  function window(state: Partial<NotificationWindow> = {}) {
    const posted: unknown[] = [];
    let focused = 0;
    const client: NotificationWindow = {
      focused: false,
      visibilityState: "hidden",
      postMessage: (m) => { posted.push(m); },
      focus: async () => { focused++; return client; },
      ...state,
    };
    return { client, posted, focusCount: () => focused };
  }

  function clients(windows: NotificationWindow[]) {
    const opened: string[] = [];
    return {
      opened,
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); return null; },
    };
  }

  it("hands the session to the window in front, and focuses it", async () => {
    const background = window();
    const front = window({ focused: true, visibilityState: "visible" });
    const all = clients([background.client, front.client]);
    await routeNotificationClick(push, all, ORIGIN);
    expect(front.posted).toEqual([{ type: OPEN_FROM_NOTIFICATION, url: push.url, project: "ppm", sessionId: "s1", providerId: "codex" }]);
    expect(front.focusCount()).toBe(1);
    expect(background.posted).toEqual([]);
    expect(all.opened).toEqual([]);
  });

  it("uses a background window rather than opening a second PPM", async () => {
    const background = window();
    const all = clients([background.client]);
    await routeNotificationClick(push, all, ORIGIN);
    expect(background.posted).toHaveLength(1);
    expect(all.opened).toEqual([]);
  });

  it("opens the URL when no window is open, or when it is on another origin", async () => {
    const none = clients([]);
    await routeNotificationClick(push, none, ORIGIN);
    expect(none.opened).toEqual([push.url]);

    const other = window({ focused: true });
    const elsewhere = clients([other.client]);
    const moved = readWebPushPayload({ url: "https://new-tunnel.trycloudflare.com/project/ppm?openChat=s1" });
    await routeNotificationClick(moved, elsewhere, ORIGIN);
    expect(other.posted).toEqual([]);
    expect(elsewhere.opened).toEqual([moved.url]);
  });

  it("still delivers the session when the browser refuses to focus", async () => {
    const stubborn = window({ focus: async () => { throw new Error("Not allowed to focus a window"); } });
    await routeNotificationClick(push, clients([stubborn.client]), ORIGIN);
    expect(stubborn.posted).toHaveLength(1);
  });
});
