/**
 * `sendToChat({ newTab: true })` is how "Hand off to code" starts a conversation: it must
 * never deliver into the chat the user last selected (or a design session), only ever open a
 * fresh chat with the text as an editable draft.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const eventBus = new EventTarget();
(globalThis as { window?: unknown }).window = eventBus;
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { sendToChat, SEND_TO_CHAT_EVENT } = await import("../../../src/web/lib/send-to-chat");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

const chatTab = (id: string) => ({
  id, type: "chat" as const, title: "Chat", projectId: "demo", closable: true,
  metadata: { lastActiveAt: 500, projectName: "demo", sessionId: "s-1" },
});

let original: Record<string, unknown>;
let opened: Array<Record<string, unknown>>;
let activated: string[];
let updated: string[];
let events: number;
const onEvent = () => { events++; };

beforeEach(() => {
  const s = usePanelStore.getState();
  original = { panels: s.panels, focusedPanelId: s.focusedPanelId, setActiveTab: s.setActiveTab, updateTab: s.updateTab, openTab: s.openTab };
  opened = [];
  activated = [];
  updated = [];
  events = 0;
  eventBus.addEventListener(SEND_TO_CHAT_EVENT, onEvent);
  usePanelStore.setState({
    panels: { left: { id: "left", tabs: [chatTab("chat:existing")], activeTabId: "chat:existing", tabHistory: [] } } as never,
    focusedPanelId: "left",
    setActiveTab: ((id: string) => { activated.push(id); }) as never,
    updateTab: ((id: string) => { updated.push(id); }) as never,
    openTab: ((tab: Record<string, unknown>) => { opened.push(tab); return "chat:new"; }) as never,
  });
});
afterEach(() => {
  eventBus.removeEventListener(SEND_TO_CHAT_EVENT, onEvent);
  usePanelStore.setState(original as never);
});

describe("sendToChat newTab", () => {
  it("opens a new plain chat with the text as its pending draft, even with a chat selected", () => {
    sendToChat({ text: "Implement the design", projectName: "demo", newTab: true });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ type: "chat", metadata: { projectName: "demo", pendingMessage: "Implement the design" } });
    expect((opened[0]!.metadata as Record<string, unknown>).sessionId).toBeUndefined();
    expect((opened[0]!.metadata as Record<string, unknown>).designSlug).toBeUndefined();
    expect(activated).toEqual([]);
    expect(updated).toEqual([]);
    expect(events).toBe(0);
  });

  it("still reuses the selected chat without it", () => {
    sendToChat({ text: "output", projectName: "demo" });
    expect(opened).toEqual([]);
    expect(activated).toEqual(["chat:existing"]);
    expect(events).toBe(1);
  });

  it("does nothing for blank text", () => {
    sendToChat({ text: "   ", projectName: "demo", newTab: true });
    expect(opened).toEqual([]);
  });
});
