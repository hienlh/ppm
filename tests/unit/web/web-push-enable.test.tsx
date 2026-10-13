/**
 * Turning push on in this browser, against a stub browser and server: what `enablePush` makes
 * of the push service's answer, and where Settings → Notifications puts it.
 *
 * The decisions are pinned in `web-push-browser.test.ts`. This file is for the wiring around
 * them — which browser `enablePush` says it is, the deadline it puts on `subscribe`, the name it
 * saves the device under, and the pane keeping the reason on screen — none of which a test of
 * the pure functions can see.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);

/** Granted on request, as after the user allows the prompt. */
class FakeNotification {
  static permission: NotificationPermission = "default";
  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.permission = "granted";
    return "granted";
  }
}
installGlobal("Notification", FakeNotification);
afterAll(uninstallDom);

const { act } = await import("react");
const { enablePush } = await import("../../../src/web/lib/web-push-client");
const { PUSH_SUBSCRIBE_DEADLINE_MS, bytesToBase64Url } = await import("../../../src/web/lib/web-push-support");
const { NotificationsSettingsSection } = await import("../../../src/web/components/settings/notifications-settings-section");
const { DEFAULT_NOTIFICATION_SETTINGS } = await import("../../../src/shared/notification-settings");

/** Chrome 155 on a Mac. Brave sends the same. */
const MAC_CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const KEY = bytesToBase64Url(Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i)));
/** What Brave 1.97 rejects with while "Use Google services for push messaging" is off. */
const BRAVE_REFUSAL = () => new DOMException("Registration failed - push service error", "AbortError");

// happy-dom has no push, service worker or secure-context flag; each test adds them and
// `afterEach` takes them off the process-wide window and navigator again.
const undo: (() => void)[] = [];
function override(target: object, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  undo.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

/**
 * A secure page in Chrome or Brave on a Mac, with PPM's service worker registered and no
 * subscription yet. `subscribe` waits until the test answers it through `push`.
 */
function browser(name: "Chrome" | "Brave") {
  const asked = Promise.withResolvers<void>();
  const push = Promise.withResolvers<PushSubscription>();
  const registration = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: () => {
        asked.resolve();
        return push.promise;
      },
    },
  };
  override(navigator, "userAgent", MAC_CHROME_UA);
  override(navigator, "platform", "MacIntel");
  override(navigator, "maxTouchPoints", 0);
  override(navigator, "userAgentData", {
    brands: name === "Brave" ? [{ brand: "Brave" }, { brand: "Chromium" }] : [{ brand: "Google Chrome" }, { brand: "Chromium" }],
  });
  if (name === "Brave") override(navigator, "brave", { isBrave: async () => true });
  override(navigator, "serviceWorker", { getRegistration: async () => registration, ready: Promise.resolve(registration) });
  override(window, "isSecureContext", true);
  override(window, "PushManager", class {});
  override(window, "Notification", FakeNotification);
  return { asked: asked.promise, push };
}

interface Answer { status?: number; body: unknown }
type Req = { method: string; url: string; body: unknown };
type Route = (req: Req) => Answer | undefined;

const realFetch = globalThis.fetch;
let requests: Req[] = [];
let routes: Route[] = [];

function on(method: string, url: string, answer: Answer | ((req: Req) => Answer)): Route {
  return (req) => (req.method === method && req.url === url ? (typeof answer === "function" ? answer(req) : answer) : undefined);
}
const ok = (data: unknown): Answer => ({ body: { ok: true, data } });
const serve = (...extra: Route[]) => { routes = [...extra, ...routes]; };
const sent = (method: string, url: string) => requests.filter((r) => r.method === method && r.url === url);

beforeEach(() => {
  FakeNotification.permission = "default";
  requests = [];
  routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    for (const route of routes) {
      const answer = route(req);
      if (answer) return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: false, error: `no stub for ${req.method} ${req.url}` }), { status: 599 });
  }) as typeof fetch;
});

let view: Mounted | null = null;
afterEach(async () => {
  jest.useRealTimers();
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
  for (const step of undo.splice(0).reverse()) step();
});

/** Lets a promise chain run on after a fake timer fires: fake timers leave microtasks alone. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = () => document.body.textContent ?? "";

/** The "This device" switch: its row's label points at it. */
function pushSwitch(): HTMLElement {
  const label = [...document.body.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === "This device");
  const target = label && document.getElementById(label.getAttribute("for") ?? "");
  if (!target) throw new Error("no push switch");
  return target;
}

describe("enablePush", () => {
  it("walks Brave users to the setting when Brave refuses to subscribe", async () => {
    const brave = browser("Brave");
    const failure = enablePush(KEY).then(() => null, (e: unknown) => e as Error);
    await brave.asked;
    brave.push.reject(BRAVE_REFUSAL());

    const message = (await failure)?.message;
    expect(message).toContain("brave://settings/privacy");
    expect(message).toContain("Use Google services for push messaging");
    expect(sent("POST", "/api/notifications/push/subscribe")).toHaveLength(0);
  });

  // Chrome kept retrying for minutes with Google's hosts unresolvable, and never rejected.
  it("gives up on a push service that never answers, after a minute", async () => {
    const chrome = browser("Chrome");
    jest.useFakeTimers();
    let outcome: unknown = "pending";
    void enablePush(KEY).then(() => { outcome = "subscribed"; }, (e: unknown) => { outcome = e; });
    await chrome.asked;

    jest.advanceTimersByTime(PUSH_SUBSCRIBE_DEADLINE_MS - 1);
    await drain();
    expect(outcome).toBe("pending");

    jest.advanceTimersByTime(1);
    await drain();
    expect((outcome as Error).message).toStartWith("Chrome got no answer from Google's push service within a minute.");
  });
});

describe("Settings → Notifications → Push", () => {
  it("keeps the reason push could not be turned on under the switch, and says it is waiting meanwhile", async () => {
    const brave = browser("Brave");
    serve(
      on("GET", "/api/notifications/settings", ok(DEFAULT_NOTIFICATION_SETTINGS)),
      on("GET", "/api/notifications/push", ok({ publicKey: KEY, devices: [] })),
      on("GET", "/api/notifications/ntfy", ok({ configured: false, server: "", topic: "", hasToken: false })),
      on("GET", "/api/notifications/telegram", ok({
        configured: false, botUsername: null, sharedWithPPMBot: false, chats: [],
        connect: { active: false, expiresAt: null, error: null },
      })),
    );
    view = await mount(<NotificationsSettingsSection />);
    await settle();

    await click(pushSwitch());
    await brave.asked;
    await settle();
    expect(text()).toContain("Waiting for the browser's push service");

    await act(async () => { brave.push.reject(BRAVE_REFUSAL()); });
    await settle();
    expect(text()).not.toContain("Waiting for the browser's push service");
    // In the pane, not in a toast: nothing here renders a toast, so a toast would leave no text.
    const section = pushSwitch().closest("section");
    expect(section?.textContent).toContain("brave://settings/privacy");
    expect(pushSwitch().hasAttribute("disabled")).toBe(false);
  });
});
