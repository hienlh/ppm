/**
 * Settings → PPMBot → Telegram against a stub server: what each control sends, and that
 * it talks to PPMBot's own bot and chats — never the notification ones.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
const { PPMBotTelegramSection } = await import("../../../src/web/components/settings/ppmbot-telegram-section");
const { NotificationsSettingsSection } = await import("../../../src/web/components/settings/notifications-settings-section");
const { DEFAULT_NOTIFICATION_SETTINGS } = await import("../../../src/shared/notification-settings");

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

const NO_LINK = { active: false, expiresAt: null, error: null };
const UNSET = {
  configured: false, botUsername: null, sharedWithNotifications: false, enabled: false, running: false,
  chats: [], connect: NO_LINK,
};
const READY = {
  ...UNSET,
  configured: true,
  botUsername: "ppm_ai_bot",
  chats: [{ chatId: "42", name: "Thang (@thang)" }],
};

beforeEach(() => {
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
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

const text = () => document.body.textContent ?? "";

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PPMBot's Telegram section", () => {
  it("asks for a bot of its own first, and saves the token to PPMBot's endpoint", async () => {
    let status: object = UNSET;
    serve(
      (req) => (req.method === "GET" && req.url === "/api/settings/clawbot/telegram" ? ok(status) : undefined),
      on("PUT", "/api/settings/clawbot/telegram", () => {
        status = { ...UNSET, configured: true, botUsername: "ppm_ai_bot" };
        return ok({ bot_token: "555666...", bot_username: "ppm_ai_bot" });
      }),
    );
    view = await mount(<PPMBotTelegramSection />);
    await settle();
    expect(text()).toContain("Create a new bot for PPMBot");
    expect(text()).not.toContain("Turn on PPMBot");

    await typeInto(document.body.querySelector("input[type=password]") as HTMLInputElement, `555666777:${"B".repeat(35)}`);
    await click(button("Save"));
    await settle();
    expect(sent("PUT", "/api/settings/clawbot/telegram").map((r) => r.body)).toEqual([{ bot_token: `555666777:${"B".repeat(35)}` }]);
    expect(sent("PUT", "/api/settings/telegram")).toHaveLength(0);
    expect(text()).toContain("Turn on PPMBot");
  });

  it("turns PPMBot on with the switch alone", async () => {
    let status: object = READY;
    serve(
      (req) => (req.method === "GET" && req.url === "/api/settings/clawbot/telegram" ? ok(status) : undefined),
      on("PUT", "/api/settings/clawbot", () => {
        status = { ...READY, enabled: true, running: true };
        return ok({});
      }),
    );
    view = await mount(<PPMBotTelegramSection />);
    await settle();
    expect(text()).toContain("Off");

    await click(document.body.querySelector('button[role="switch"]'));
    await settle();
    expect(sent("PUT", "/api/settings/clawbot").map((r) => r.body)).toEqual([{ enabled: true }]);
    expect(text()).toContain("Answering as @ppm_ai_bot");
  });

  it("disconnects a chat from PPMBot", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok(READY)),
      on("DELETE", "/api/settings/clawbot/paired/42", ok({ revoked: true })),
    );
    view = await mount(<PPMBotTelegramSection />);
    await settle();

    await click(button("Disconnect Thang (@thang)"));
    await settle();
    expect(sent("DELETE", "/api/settings/clawbot/paired/42")).toHaveLength(1);
    expect(requests.some((r) => r.url.startsWith("/api/notifications"))).toBe(false);
  });

  it("makes a connect link for PPMBot's bot", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok({ ...READY, chats: [] })),
      on("POST", "/api/settings/clawbot/telegram/connect", ok({ url: "https://t.me/ppm_ai_bot?start=abcdefghijklmnopqrstuv", expiresAt: Date.now() + 600_000 })),
      on("DELETE", "/api/settings/clawbot/telegram/connect", ok({ cancelled: true })),
    );
    view = await mount(<PPMBotTelegramSection />);
    await settle();
    await click(button("Connect Telegram"));
    await settle();
    expect(sent("POST", "/api/settings/clawbot/telegram/connect")).toHaveLength(1);
    const open = document.body.querySelector<HTMLAnchorElement>('a[href^="https://t.me/"]');
    expect(open?.href).toBe("https://t.me/ppm_ai_bot?start=abcdefghijklmnopqrstuv");

    await click(button("Cancel"));
    await settle();
    expect(sent("DELETE", "/api/settings/clawbot/telegram/connect")).toHaveLength(1);
  });

  it("warns when PPMBot still shares the notification bot", async () => {
    serve(on("GET", "/api/settings/clawbot/telegram", ok({ ...READY, sharedWithNotifications: true })));
    view = await mount(<PPMBotTelegramSection />);
    await settle();
    expect(text()).toContain("Notifications use this bot too");
  });
});

describe("Notifications → Telegram", () => {
  it("disconnects a chat from alerts only", async () => {
    serve(
      on("GET", "/api/notifications/settings", ok(DEFAULT_NOTIFICATION_SETTINGS)),
      on("GET", "/api/notifications/push", ok({ publicKey: "", devices: [] })),
      on("GET", "/api/notifications/ntfy", ok({ configured: false, server: "", topic: "", hasToken: false })),
      on("GET", "/api/notifications/telegram", ok({
        configured: true, botUsername: "ppm_noti_bot", sharedWithPPMBot: false,
        chats: [{ chatId: "42", name: "Thang (@thang)" }], connect: NO_LINK,
      })),
      on("DELETE", "/api/notifications/telegram/chats/42", ok({ removed: true })),
    );
    view = await mount(<NotificationsSettingsSection />);
    await settle();
    await click(button("Disconnect Thang (@thang)"));
    await settle();
    expect(sent("DELETE", "/api/notifications/telegram/chats/42")).toHaveLength(1);
    expect(requests.some((r) => r.url.startsWith("/api/settings/clawbot"))).toBe(false);
  });
});
