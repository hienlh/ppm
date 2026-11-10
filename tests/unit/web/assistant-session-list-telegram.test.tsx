/**
 * The Assistant's session list on Telegram: the session a connected chat talks to wears a
 * "Telegram" label, and a row's menu puts the session on Telegram — on a desktop by right-click,
 * on a phone by a long press, choosing the chat when several are connected. The menu item exists
 * only while the bridge is on and a chat is connected, and the label follows the server's
 * binding-changed event without a reload.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
// The radix menu's focus trap watches its own content for removals.
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);

const { act } = await import("react");
const { AssistantSessionList } = await import("../../../src/web/components/settings/assistant/assistant-session-list");
const { TELEGRAM_BINDING_CHANGED_EVENT, parseAssistantTelegramState } = await import("../../../src/web/hooks/use-assistant-telegram-binding");
const { api } = await import("../../../src/web/lib/api-client");

const SESSIONS = [
  { id: "s1", providerId: "claude", title: "Morning check", createdAt: "2026-10-11T01:00:00Z" },
  { id: "s2", providerId: "codex", title: "Query orders", createdAt: "2026-10-11T02:00:00Z" },
];
const ONE_CHAT = {
  enabled: true, running: true, error: null,
  chats: [{ chatId: "42", name: "Thang (@thang)", sessionId: "s1", sessionTitle: "Morning check" }],
};

let binding: unknown = ONE_CHAT;
let posts: Array<{ url: string; body: unknown }> = [];
let setMain: string[] = [];
let deleted: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
let view: Mounted | null = null;
const realWidth = window.innerWidth;

beforeEach(() => {
  binding = ONE_CHAT;
  posts = [];
  setMain = [];
  deleted = [];
  spies.push(
    spyOn(api, "get").mockImplementation((async (url: string) => {
      if (url === "/api/assistant/telegram") return binding;
      throw new Error(`no stub for GET ${url}`);
    }) as never),
    spyOn(api, "post").mockImplementation((async (url: string, body: unknown) => {
      posts.push({ url, body });
      return { chatId: "42", sessionId: "s2", providerId: "codex" };
    }) as never),
  );
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const row = (title: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('ul[aria-label="Assistant sessions"] button')].find((b) => b.textContent?.includes(title))!;
const labelOn = (title: string) => row(title).querySelector("[data-testid=assistant-session-telegram]") !== null;
const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
const telegramItems = () => menuItems().filter((t) => t?.includes("Telegram"));

async function rightClick(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await settle();
}

async function longPress(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true })); });
  await act(async () => { await Bun.sleep(450); });
  await act(async () => { el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true })); });
  await settle();
}

async function mountList(onSelect: (id: string) => void = () => {}) {
  view = await mount(<AssistantSessionList sessions={SESSIONS} mainSessionId="s1" onOpen={(s) => onSelect(s.id)}
    onSetMain={(s) => setMain.push(s.id)} onDelete={(s) => deleted.push(s.id)} />);
  await settle();
}

describe("on a desktop", () => {
  it("labels the session a chat talks to, and only that one", async () => {
    await mountList();
    expect(labelOn("Morning check")).toBe(true);
    expect(labelOn("Query orders")).toBe(false);
    expect(row("Morning check").querySelector("[data-testid=assistant-session-telegram]")!.getAttribute("title")).toBe("Telegram: Thang (@thang)");
  });

  it("puts another session on Telegram from its menu", async () => {
    await mountList();
    await rightClick(row("Query orders"));
    // A Codex session cannot be the main one, so its menu has no "Set as main session".
    expect(menuItems()).toEqual(["Open", "Use on Telegram", "Delete"]);
    binding = { ...ONE_CHAT, chats: [{ ...ONE_CHAT.chats[0]!, sessionId: "s2", sessionTitle: "Query orders" }] };
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === "Use on Telegram")!;
    await click(item);
    await settle();
    expect(posts).toEqual([{ url: "/api/assistant/telegram/bind", body: { sessionId: "s2", chatId: "42" } }]);
    // Refetched after the bind: the label moved.
    expect(labelOn("Query orders")).toBe(true);
    expect(labelOn("Morning check")).toBe(false);
  });

  it("offers nothing to do for the session the chat already talks to", async () => {
    await mountList();
    await rightClick(row("Morning check"));
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes("Telegram"))!;
    expect(item.textContent?.trim()).toBe("On Telegram");
    expect(item.getAttribute("aria-disabled") ?? item.getAttribute("data-disabled")).not.toBeNull();
  });

  it("offers Set as main session on a Claude session that is not the main one, and Delete on every one", async () => {
    view = await mount(<AssistantSessionList sessions={[...SESSIONS, { id: "s3", providerId: "claude", title: "Evening", createdAt: "2026-10-11T03:00:00Z" }]}
      mainSessionId="s1" onOpen={() => {}} onSetMain={(s) => setMain.push(s.id)} onDelete={(s) => deleted.push(s.id)} />);
    await settle();
    await rightClick(row("Morning check"));
    expect(menuItems()).not.toContain("Set as main session");
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    await rightClick(row("Evening"));
    const setAsMain = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === "Set as main session")!;
    await click(setAsMain);
    await settle();
    expect(setMain).toEqual(["s3"]);
  });

  it("deletes a session only after the confirmation", async () => {
    await mountList();
    await rightClick(row("Query orders"));
    await click([...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.trim() === "Delete")!);
    await settle();
    expect(deleted).toEqual([]);
    expect(document.body.textContent).toContain("Delete this session?");
    const confirm = [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Delete").at(-1)!;
    await click(confirm);
    await settle();
    expect(deleted).toEqual(["s2"]);
  });

  it("has no Telegram item while the bridge is off or no chat is connected, and a tap still opens", async () => {
    for (const off of [{ ...ONE_CHAT, enabled: false }, { ...ONE_CHAT, chats: [] }]) {
      binding = off;
      const picked: string[] = [];
      await mountList((id) => picked.push(id));
      await rightClick(row("Query orders"));
      expect(telegramItems()).toEqual([]);
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      await settle();
      await click(row("Query orders"));
      expect(picked).toEqual(["s2"]);
      await view!.unmount();
      view = null;
    }
  });

  it("moves the label when the server says a chat's session changed", async () => {
    await mountList();
    binding = { ...ONE_CHAT, chats: [{ ...ONE_CHAT.chats[0]!, sessionId: "s2" }] };
    await act(async () => { window.dispatchEvent(new CustomEvent(TELEGRAM_BINDING_CHANGED_EVENT, { detail: {} })); });
    await settle();
    expect(labelOn("Query orders")).toBe(true);
    expect(labelOn("Morning check")).toBe(false);
  });

  it("hides everything when the server cannot say", async () => {
    spies.push(spyOn(api, "get").mockRejectedValue(new Error("down") as never));
    await mountList();
    expect(labelOn("Morning check")).toBe(false);
    await rightClick(row("Query orders"));
    expect(telegramItems()).toEqual([]);
  });
});

describe("on a phone", () => {
  beforeEach(() => Object.defineProperty(window, "innerWidth", { value: 390, configurable: true }));

  it("opens the menu with a long press and lets the user pick which chat", async () => {
    binding = {
      ...ONE_CHAT,
      chats: [...ONE_CHAT.chats, { chatId: "7", name: "Second phone", sessionId: null, sessionTitle: null }],
    };
    await mountList();
    await longPress(row("Query orders"));
    const sheetButtons = [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(sheetButtons).toContain("Thang (@thang)");
    expect(sheetButtons).toContain("Second phone");
    const second = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Second phone")!;
    await click(second);
    await settle();
    expect(posts).toEqual([{ url: "/api/assistant/telegram/bind", body: { sessionId: "s2", chatId: "7" } }]);
  });

  it("keeps the rows touch-sized", async () => {
    await mountList();
    expect(row("Query orders").className).toContain("min-h-11");
    expect(row("Query orders").className).toContain("select-none");
  });
});

describe("reading the server's answer", () => {
  it("drops malformed chats and treats a non-answer as no Telegram", () => {
    expect(parseAssistantTelegramState(null)).toBeNull();
    expect(parseAssistantTelegramState({ enabled: true })).toBeNull();
    expect(parseAssistantTelegramState({ enabled: true, running: false, chats: [{ chatId: 5 }, { chatId: "9", sessionId: "" }] }))
      .toEqual({ enabled: true, running: false, error: null, chats: [{ chatId: "9", name: "9", sessionId: null, sessionTitle: null }] });
  });
});
