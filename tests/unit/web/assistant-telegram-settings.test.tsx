/**
 * Settings → PPM Assistant → Telegram against a stub server: what each control sends, that it
 * uses the Assistant's own bot and chats (never the notification ones), that the token is only
 * ever sent, and that an old link to the retired PPMBot pane lands here.
 *
 * Also the old PPMBot memories beside the instructions: listed, never copied until a press.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installGlobal("MutationObserver", window.MutationObserver);
// The General panel's provider picker (radix Select) builds a fragment while it mounts.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);

const { act } = await import("react");
const { AssistantTelegramSettings, parseDebounceMs } = await import("../../../src/web/components/settings/assistant-telegram-settings");
const { AssistantSettingsSection } = await import("../../../src/web/components/settings/assistant-settings-section");
const { AssistantLegacyMemories, appendToInstructions, parseLegacyMemories } = await import("../../../src/web/components/settings/assistant-legacy-memories");
const { resolveSettingsLink, useAssistantSettingsTab } = await import("../../../src/web/components/settings/assistant-settings-tab-store");
const { isSettingsCategoryId, SETTINGS_CATEGORIES } = await import("../../../src/web/components/settings/settings-categories");
const { SECTIONS } = await import("../../../src/web/components/settings/settings-section-content");
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

const TOKEN = `555666777:${"B".repeat(35)}`;
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
const OPTIONS = { enabled: false, show_tool_calls: true, debounce_ms: 2000 };
const BINDINGS = {
  enabled: false, running: false, error: null,
  chats: [{ chatId: "42", name: "Thang (@thang)", sessionId: "s-1", sessionTitle: "Morning check" }],
};

beforeEach(() => {
  requests = [];
  // Fallbacks every mount asks for; a test's own `serve` goes in front of them.
  routes = [
    on("GET", "/api/settings/clawbot", ok(OPTIONS)),
    on("GET", "/api/assistant/telegram", ok(BINDINGS)),
    on("GET", "/api/assistant/telegram/legacy-memories", ok({ memories: [] })),
  ];
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
  useAssistantSettingsTab.setState({ tab: "general" });
});

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

const text = () => document.body.textContent ?? "";

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof window.HTMLInputElement ? window.HTMLInputElement.prototype : Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the Assistant's Telegram settings", () => {
  it("asks for a bot of its own first, saves the token to the Assistant's endpoint, and never shows it", async () => {
    let status: object = UNSET;
    serve(
      (req) => (req.method === "GET" && req.url === "/api/settings/clawbot/telegram" ? ok(status) : undefined),
      on("PUT", "/api/settings/clawbot/telegram", () => {
        status = { ...UNSET, configured: true, botUsername: "ppm_ai_bot" };
        return ok({ bot_token: "555666...", bot_username: "ppm_ai_bot" });
      }),
    );
    view = await mount(<AssistantTelegramSettings />);
    await settle();
    expect(text()).toContain("Create a new bot for the Assistant");
    expect(text()).not.toContain("Use the Assistant on Telegram");

    await typeInto(document.body.querySelector("input[type=password]") as HTMLInputElement, TOKEN);
    await click(button("Save"));
    await settle();
    expect(sent("PUT", "/api/settings/clawbot/telegram").map((r) => r.body)).toEqual([{ bot_token: TOKEN }]);
    expect(sent("PUT", "/api/settings/telegram")).toHaveLength(0);
    expect(text()).toContain("Use the Assistant on Telegram");
    // Neither printed nor left in a field.
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect([...document.body.querySelectorAll("input")].some((i) => i.value.includes("555666777"))).toBe(false);
  });

  it("switches the bridge on with `enabled` alone", async () => {
    let status: object = READY;
    serve(
      (req) => (req.method === "GET" && req.url === "/api/settings/clawbot/telegram" ? ok(status) : undefined),
      on("PUT", "/api/settings/clawbot", () => {
        status = { ...READY, enabled: true, running: true };
        return ok({ ...OPTIONS, enabled: true });
      }),
    );
    view = await mount(<AssistantTelegramSettings />);
    await settle();
    expect(text()).toContain("Off");

    await click(document.body.querySelector('button[role="switch"]'));
    await settle();
    expect(sent("PUT", "/api/settings/clawbot").map((r) => r.body)).toEqual([{ enabled: true }]);
    expect(text()).toContain("Answering as @ppm_ai_bot");
  });

  it("shows which session each connected chat talks to", async () => {
    serve(on("GET", "/api/settings/clawbot/telegram", ok({
      ...READY, chats: [...READY.chats, { chatId: "7", name: "Second phone" }],
    })), on("GET", "/api/assistant/telegram", ok({
      ...BINDINGS,
      chats: [...BINDINGS.chats, { chatId: "7", name: "Second phone", sessionId: null, sessionTitle: null }],
    })));
    view = await mount(<AssistantTelegramSettings />);
    await settle();
    expect(text()).toContain("Talks to “Morning check”");
    expect(text()).toContain("No session yet");
  });

  it("disconnects a chat from the Assistant only", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok(READY)),
      on("DELETE", "/api/settings/clawbot/paired/42", ok({ revoked: true })),
    );
    view = await mount(<AssistantTelegramSettings />);
    await settle();

    await click(button("Disconnect Thang (@thang)"));
    await settle();
    expect(sent("DELETE", "/api/settings/clawbot/paired/42")).toHaveLength(1);
    expect(requests.some((r) => r.url.startsWith("/api/notifications"))).toBe(false);
  });

  it("makes a connect link for the Assistant's bot", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok({ ...READY, chats: [] })),
      on("POST", "/api/settings/clawbot/telegram/connect", ok({ url: "https://t.me/ppm_ai_bot?start=abcdefghijklmnopqrstuv", expiresAt: Date.now() + 600_000 })),
      on("DELETE", "/api/settings/clawbot/telegram/connect", ok({ cancelled: true })),
    );
    view = await mount(<AssistantTelegramSettings />);
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

  it("saves tool names and message grouping with only the keys the bridge still reads", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok(READY)),
      on("PUT", "/api/settings/clawbot", (req) => ok({ ...OPTIONS, ...(req.body as object) })),
    );
    view = await mount(<AssistantTelegramSettings />);
    await settle();

    const toolNames = [...document.body.querySelectorAll('button[role="switch"]')][1]!;
    await click(toolNames);
    await settle();

    const grouping = document.body.querySelector<HTMLInputElement>("#assistant-telegram-debounce")!;
    expect(grouping.value).toBe("2000");
    await typeInto(grouping, "500");
    await settle();
    await click(button("Save"));
    await settle();

    expect(sent("PUT", "/api/settings/clawbot").map((r) => r.body)).toEqual([{ show_tool_calls: false }, { debounce_ms: 500 }]);
    for (const r of sent("PUT", "/api/settings/clawbot")) {
      expect(Object.keys(r.body as object).every((k) => ["enabled", "show_tool_calls", "debounce_ms"].includes(k))).toBe(true);
    }
  });

  it("refuses a grouping the server would refuse", () => {
    expect(parseDebounceMs("0")).toBe(0);
    expect(parseDebounceMs(" 30000 ")).toBe(30000);
    expect(parseDebounceMs("30001")).toBeNull();
    expect(parseDebounceMs("-1")).toBeNull();
    expect(parseDebounceMs("1.5")).toBeNull();
    expect(parseDebounceMs("")).toBeNull();
  });

  it("warns when the Assistant still shares the notification bot", async () => {
    serve(on("GET", "/api/settings/clawbot/telegram", ok({ ...READY, sharedWithNotifications: true })));
    view = await mount(<AssistantTelegramSettings />);
    await settle();
    expect(text()).toContain("Notifications use this bot too");
  });
});

describe("where the old PPMBot pane went", () => {
  it("is no longer a category of its own", () => {
    expect(isSettingsCategoryId("ppmbot")).toBe(false);
    expect(SETTINGS_CATEGORIES.some((c) => c.label === "PPMBot")).toBe(false);
    expect(Object.keys(SECTIONS)).not.toContain("ppmbot");
  });

  it("leads an old `ppmbot` link to PPM Assistant → Telegram", () => {
    useAssistantSettingsTab.setState({ tab: "general" });
    expect(resolveSettingsLink("ppmbot")).toBe("assistant");
    expect(useAssistantSettingsTab.getState().tab).toBe("telegram");
    // Real ids pass through and leave the sub-tab alone; anything else names nothing.
    useAssistantSettingsTab.setState({ tab: "general" });
    expect(resolveSettingsLink("assistant")).toBe("assistant");
    expect(resolveSettingsLink("notifications")).toBe("notifications");
    expect(resolveSettingsLink("toString")).toBeUndefined();
    expect(resolveSettingsLink(42)).toBeUndefined();
    expect(useAssistantSettingsTab.getState().tab).toBe("general");
  });

  it("opens the pane on the Telegram sub-tab and keeps the General draft when switching back", async () => {
    serve(
      on("GET", "/api/settings/clawbot/telegram", ok(READY)),
      on("GET", "/api/assistant/settings", ok({
        settings: { default_provider: null, providers: {}, instructions: "", mcp_servers: [] },
        providers: [{ id: "claude", name: "Claude" }],
        limits: { instructionsMaxChars: 8000, maxServers: 20 },
      })),
    );
    resolveSettingsLink("ppmbot");
    view = await mount(<AssistantSettingsSection />);
    await settle();
    const pane = document.body.querySelector("[data-testid=assistant-settings]")!;
    expect(pane.getAttribute("data-tab")).toBe("telegram");
    expect(text()).toContain("Use the Assistant on Telegram");

    await click(button("General"));
    await settle();
    await typeInto(document.body.querySelector("#asst-instructions") as HTMLTextAreaElement, "Answer in Vietnamese.");
    await click(button("Telegram"));
    await settle();
    await click(button("General"));
    await settle();
    expect((document.body.querySelector("#asst-instructions") as HTMLTextAreaElement).value).toBe("Answer in Vietnamese.");
    expect(text()).toContain("Unsaved changes");
  });
});

describe("what the old PPMBot remembered", () => {
  const MEMORIES = {
    memories: [
      { id: 2, project: "_global", category: "preference", content: "Prefers short answers", createdAt: 1_760_000_000_000 },
      { id: 1, project: "ppm", category: "fact", content: "Deploys on Fridays", createdAt: 1_750_000_000_000 },
    ],
  };

  it("is hidden when there is nothing", async () => {
    view = await mount(<AssistantLegacyMemories instructions="" onCopy={() => {}} />);
    await settle();
    expect(document.body.querySelector("[data-testid=assistant-legacy-memories]")).toBeNull();
  });

  it("lists them folded, and copies one only when asked", async () => {
    serve(on("GET", "/api/assistant/telegram/legacy-memories", ok(MEMORIES)));
    const copied: string[] = [];
    view = await mount(<AssistantLegacyMemories instructions="" onCopy={(c) => copied.push(c)} />);
    await settle();
    expect(text()).toContain("Remembered by PPMBot (2)");
    // Folded: the contents are not on screen until opened.
    expect(text()).not.toContain("Prefers short answers");
    await click(button("Remembered by PPMBot (2)Written by the old bot's AI, so none is used unless you copy it into your instructions."));
    await settle();
    expect(text()).toContain("Prefers short answers");
    expect(text()).toContain("fact · ppm");
    expect(copied).toEqual([]);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);

    const copyButtons = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.includes("Copy to instructions"));
    await click(copyButtons[1]!);
    expect(copied).toEqual(["Deploys on Fridays"]);
    // Copying edits the draft only; nothing is saved by it.
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("marks one already in the instructions as copied", async () => {
    serve(on("GET", "/api/assistant/telegram/legacy-memories", ok(MEMORIES)));
    view = await mount(<AssistantLegacyMemories instructions={"Be brief.\nDeploys on Fridays"} onCopy={() => {}} />);
    await settle();
    await click(document.body.querySelector("[data-testid=assistant-legacy-memories] button")!);
    await settle();
    const done = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Copied");
    expect(done).toHaveLength(1);
    expect(done[0]!.disabled).toBe(true);
  });

  it("appends as a line of its own and drops malformed rows", () => {
    expect(appendToInstructions("", "A")).toBe("A");
    expect(appendToInstructions("Be brief.\n\n", "A")).toBe("Be brief.\nA");
    expect(parseLegacyMemories({ memories: [{ id: 1, content: "  x  " }, { id: "2", content: "y" }, { id: 3, content: "" }, null] }))
      .toEqual([{ id: 1, project: "_global", category: "", content: "x", createdAt: 0 }]);
    expect(parseLegacyMemories(null)).toEqual([]);
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
