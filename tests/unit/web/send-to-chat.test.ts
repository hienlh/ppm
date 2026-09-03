/**
 * "Send to Chat" addressing.
 *
 * Every chat tab stays mounted, so an unaddressed event is answered by all of
 * them and the same terminal output lands in every open chat. These tests pin the
 * two properties that prevent that: the target is the chat the user last selected
 * (project-scoped when possible), and the event carries that target's id.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

const eventBus = new EventTarget();
(globalThis as any).window = eventBus;
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { resolveSelectedChatTabId, sendToChat, SEND_TO_CHAT_EVENT, SEND_TO_CHAT_ACK_EVENT } =
  await import("../../../src/web/lib/send-to-chat");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

const chatTab = (id: string, lastActiveAt: number, projectName?: string) => ({
  id,
  type: "chat" as const,
  title: "Chat",
  projectId: projectName ?? null,
  closable: true,
  metadata: { lastActiveAt, ...(projectName ? { projectName } : {}) },
});

/** `selectedId` is the panel's active tab — what the user has picked in its tab strip. */
const panelWith = (id: string, tabs: any[], selectedId?: string | null) => ({
  id,
  tabs,
  activeTabId: selectedId !== undefined ? selectedId : (tabs[0]?.id ?? null),
  tabHistory: [],
});

let original: any;
beforeEach(() => {
  original = {
    panels: usePanelStore.getState().panels,
    setActiveTab: usePanelStore.getState().setActiveTab,
    updateTab: usePanelStore.getState().updateTab,
    openTab: usePanelStore.getState().openTab,
  };
});
afterEach(() => {
  usePanelStore.setState(original);
});

describe("resolveSelectedChatTabId", () => {
  it("picks the chat selected in its panel over a newer-stamped hidden one", () => {
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [chatTab("chat:selected", 100), chatTab("chat:hidden", 900)], "chat:selected"),
      } as any,
      focusedPanelId: "left",
    });
    expect(resolveSelectedChatTabId()).toBe("chat:selected");
  });

  it("prefers the focused panel when both panels show a chat", () => {
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [chatTab("chat:a", 900)], "chat:a"),
        right: panelWith("right", [chatTab("chat:b", 100)], "chat:b"),
      } as any,
      focusedPanelId: "right",
    });
    expect(resolveSelectedChatTabId()).toBe("chat:b");
  });

  it("falls back to the newest activation when no chat is selected anywhere", () => {
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [chatTab("chat:a", 100)], "editor:x"),
        right: panelWith("right", [chatTab("chat:b", 500)], "editor:y"),
      } as any,
      focusedPanelId: "left",
    });
    expect(resolveSelectedChatTabId()).toBe("chat:b");
  });

  it("prefers the requested project even over a selected chat of another project", () => {
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [chatTab("chat:ppm", 100, "ppm")], "editor:x"),
        right: panelWith("right", [chatTab("chat:other", 900, "other")], "chat:other"),
      } as any,
      focusedPanelId: "right",
    });
    expect(resolveSelectedChatTabId("ppm")).toBe("chat:ppm");
  });

  it("ignores non-chat tabs and reports nothing when no chat is open", () => {
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [
          { id: "terminal:1", type: "terminal", title: "T", projectId: null, closable: true, metadata: { lastActiveAt: 999 } },
        ]),
      } as any,
    });
    expect(resolveSelectedChatTabId()).toBeNull();
  });
});

describe("sendToChat", () => {
  it("addresses the event at one chat tab and focuses it", () => {
    const activated: string[] = [];
    usePanelStore.setState({
      panels: {
        left: panelWith("left", [chatTab("chat:a", 900)], "editor:x"),
        right: panelWith("right", [chatTab("chat:b", 100)], "chat:b"),
      } as any,
      focusedPanelId: "right",
      setActiveTab: ((id: string) => void activated.push(id)) as any,
    });

    // Two listeners, as two mounted chats would be: each only takes its own id.
    const delivered: string[] = [];
    const listenAs = (tabId: string) => (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.targetTabId !== tabId) return;
      delivered.push(tabId);
      window.dispatchEvent(new Event(SEND_TO_CHAT_ACK_EVENT));
    };
    const a = listenAs("chat:a");
    const b = listenAs("chat:b");
    window.addEventListener(SEND_TO_CHAT_EVENT, a);
    window.addEventListener(SEND_TO_CHAT_EVENT, b);

    sendToChat({ text: "```bash\nls\n```", label: "Terminal output" });

    window.removeEventListener(SEND_TO_CHAT_EVENT, a);
    window.removeEventListener(SEND_TO_CHAT_EVENT, b);
    expect(delivered).toEqual(["chat:b"]);
    expect(activated).toEqual(["chat:b"]);
  });

  it("leaves the text in the target's metadata when that tab is not mounted yet", () => {
    const patched: any[] = [];
    usePanelStore.setState({
      panels: { left: panelWith("left", [chatTab("chat:a", 100)]) } as any,
      setActiveTab: (() => {}) as any,
      updateTab: ((id: string, updates: any) => void patched.push({ id, updates })) as any,
    });

    sendToChat({ text: "out" });

    expect(patched).toHaveLength(1);
    expect(patched[0].id).toBe("chat:a");
    expect(patched[0].updates.metadata.pendingMessage).toBe("out");
  });

  it("opens a chat when none is open", () => {
    const opened: any[] = [];
    usePanelStore.setState({
      panels: { left: panelWith("left", []) } as any,
      openTab: ((def: any) => { opened.push(def); return "chat:new"; }) as any,
    });

    sendToChat({ text: "out", projectName: "ppm" });

    expect(opened).toHaveLength(1);
    expect(opened[0].type).toBe("chat");
    expect(opened[0].metadata).toMatchObject({ projectName: "ppm", pendingMessage: "out" });
  });

  it("ignores blank text", () => {
    const opened: any[] = [];
    usePanelStore.setState({
      panels: { left: panelWith("left", []) } as any,
      openTab: ((def: any) => { opened.push(def); return "x"; }) as any,
    });
    sendToChat({ text: "   \n" });
    expect(opened).toHaveLength(0);
  });
});
