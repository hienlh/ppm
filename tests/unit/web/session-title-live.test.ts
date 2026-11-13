/**
 * A rename announced on `/ws/global` retitles every open tab of that chat at once — in a grid
 * panel, in a floating window, in another project's kept-alive grid — and the shared session list,
 * without anyone clicking into the chat. A design tab keeps its design's name and the Assistant's
 * sessions keep the Assistant's, as they do when a chat learns its title over its own socket.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const initialPanels = usePanelStore.getState();
const initialProjects = useProjectStore.getState();
const initialLists = useSessionListStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  useProjectStore.setState(initialProjects, true);
  useSessionListStore.setState(initialLists, true);
  localStorage.clear();
  uninstallDom();
});
const { applySessionTitleChange, retitleOpenChatTabs, SESSION_TITLE_CHANGED_WINDOW_EVENT } =
  await import("../../../src/web/lib/session-title-live");
const { parseRenamedChat } = await import("../../../src/shared/chat-list-events");

type AnyTab = { id: string; type: string; title: string; projectId: string | null; closable: boolean; metadata?: Record<string, unknown> };
const tab = (id: string, type: string, title: string, metadata: Record<string, unknown>): AnyTab =>
  ({ id, type, title, projectId: (metadata.projectName as string) ?? null, closable: true, metadata });
const panel = (id: string, tabs: AnyTab[]) => ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });
const titleOf = (id: string) => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => t.id === id)?.title;

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({ projects: [{ name: "a", path: "/a" }, { name: "b", path: "/b" }] } as never);
  usePanelStore.setState({
    currentProject: "a", focusedPanelId: "a1", grid: [["a1"]], lastFocusedChatProviders: {},
    projectGrids: { a: [["a1"]], b: [["b1"]] }, projectFocused: { a: "a1", b: "b1" },
    panels: {
      a1: panel("a1", [
        tab("chat:1", "chat", "Old", { projectName: "a", sessionId: "S1" }),
        tab("chat:other", "chat", "Other", { projectName: "a", sessionId: "S2" }),
        tab("chat:design", "chat", "Landing page", { projectName: "a", sessionId: "S1", designSlug: "landing" }),
        tab("editor:x", "editor", "x.ts", { projectName: "a", filePath: "x.ts", sessionId: "S1" }),
      ]),
      "__win__:w1": panel("__win__:w1",[tab("chat:2", "chat", "Old", { projectName: "a", sessionId: "S1" })]),
      b1: panel("b1", [tab("chat:3", "chat", "Old", { projectName: "b", sessionId: "S1" })]),
    },
  } as never);
});

describe("an announced rename", () => {
  it("retitles every open tab of that chat, wherever it sits, and nothing else", () => {
    const changed = retitleOpenChatTabs("S1", "New name", "a");
    expect(changed.sort()).toEqual(["chat:1", "chat:2", "chat:3"]);
    expect(titleOf("chat:1")).toBe("New name");
    expect(titleOf("chat:2")).toBe("New name");
    expect(titleOf("chat:3")).toBe("New name");
    expect(titleOf("chat:other")).toBe("Other");
    expect(titleOf("chat:design")).toBe("Landing page");
    expect(titleOf("editor:x")).toBe("x.ts");
    // Already named so: nothing to write.
    expect(retitleOpenChatTabs("S1", "New name", "a")).toEqual([]);
  });

  it("leaves the Assistant's sessions named after the Assistant", () => {
    usePanelStore.setState({ panels: { a1: panel("a1", [tab("chat:asst", "chat", "PPM Assistant", { projectName: "__assistant__", sessionId: "A1" })]) } } as never);
    expect(retitleOpenChatTabs("A1", "Renamed", "__assistant__")).toEqual([]);
    expect(titleOf("chat:asst")).toBe("PPM Assistant");
  });

  it("renames the chat in the shared list and tells mounted views", () => {
    const ref = { name: "a", path: "/a" };
    useSessionListStore.getState().upsertSession(ref,{ id: "S1", providerId: "claude", title: "Old", createdAt: new Date().toISOString() } as never);
    const heard: unknown[] = [];
    const listener = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(SESSION_TITLE_CHANGED_WINDOW_EVENT, listener);
    try {
      applySessionTitleChange({ projectName: "a", sessionId: "S1", title: "New name" });
    } finally {
      window.removeEventListener(SESSION_TITLE_CHANGED_WINDOW_EVENT, listener);
    }
    expect(titleOf("chat:1")).toBe("New name");
    const lists = Object.values(useSessionListStore.getState().byProject);
    expect(lists.flatMap((l) => l.sessions).find((s) => s.id === "S1")?.title).toBe("New name");
    expect(heard).toEqual([{ projectName: "a", sessionId: "S1", title: "New name" }]);
  });

  it("reads `renamed` off the wire only when it is whole", () => {
    expect(parseRenamedChat({ sessionId: "S1", title: "T" })).toEqual({ sessionId: "S1", title: "T" });
    expect(parseRenamedChat(undefined)).toBeNull();
    expect(parseRenamedChat({ sessionId: "", title: "T" })).toBeNull();
    expect(parseRenamedChat({ sessionId: "S1", title: "  " })).toBeNull();
    expect(parseRenamedChat({ sessionId: "S1", title: 3 })).toBeNull();
  });
});
