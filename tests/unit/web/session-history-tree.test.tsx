/**
 * Chat History as a family tree: chats another chat opened fold under it, collapsed, with a count;
 * they open on a click, or by themselves when one of them is the chat on screen. A spec's chat
 * carries the spec's progress instead, and lists its task chats running and failed first.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, installGlobal, type Mounted } from "../../helpers/react-dom";
import type { SessionInfo } from "../../../src/types/chat";
import type { SpecSummary } from "../../../src/shared/spec-types";

installDom();
afterAll(uninstallDom);
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);
const { act } = await import("react");
const { SessionHistoryList } = await import("../../../src/web/components/chat/session-history-list");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useStreamingStore } = await import("../../../src/web/stores/streaming-store");
const { api } = await import("../../../src/web/lib/api-client");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");

const PROJECT = { name: "ppm", path: "/p" };
const s = (id: string, title: string, spawnedBy: string | null = null): SessionInfo =>
  ({ id, providerId: "claude", title, createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", spawnedBy, parentTitle: spawnedBy ? "Search spec" : null });
const LIST = [s("t2", "Task 2 · Result row", "spec"), s("t1", "Task 1 · Search store", "spec"), s("spec", "Search spec"), s("other", "Other chat")];

let specs: SpecSummary[] = [];
let view: Mounted | null = null;
let get: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  useSettingsStore.setState({ chatHistoryViewMode: "tree" });
  useProjectStore.setState({ projects: [PROJECT] as never });
  get = spyOn(api, "get").mockImplementation((async (url: string) =>
    url.includes("/tags") ? { tags: [], counts: {}, defaultTagId: null } : url.includes("/specs") ? specs : { sessions: LIST, hasMore: false }
  ) as typeof api.get);
  await useSessionListStore.getState().sync(PROJECT);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  get?.mockRestore();
  specs = [];
  useStreamingStore.setState({ sessions: new Map() });
});

const text = () => view!.container.textContent ?? "";
const toggle = () => view!.container.querySelector("button[aria-expanded]");

describe("SessionHistoryList family tree", () => {
  it("folds the task chats under the spec's chat, collapsed, at the family's newest position", async () => {
    useStreamingStore.setState({ sessions: new Map([["t2", "ppm"]]) });
    view = await mount(<SessionHistoryList projectName="ppm" variant="sidebar" />);
    expect(text()).toContain("Search spec");
    expect(text()).toContain("2 sub-chats");
    expect(text()).toContain("1 running");
    expect(text()).not.toContain("Result row");
    expect(text().indexOf("Search spec")).toBeLessThan(text().indexOf("Other chat"));
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");

    await click(toggle());
    expect(text()).toContain("Task 2 · Result row");
    expect(text()).toContain("Task 1 · Search store");
    expect(text().indexOf("Task 1")).toBeLessThan(text().indexOf("Other chat"));

    await click(toggle());
    expect(text()).not.toContain("Result row");
  });

  it("opens the family that holds the chat on screen", async () => {
    view = await mount(<SessionHistoryList projectName="ppm" variant="sidebar" sessionId="t1" />);
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Task 1 · Search store");
    await act(async () => {});
  });

  it("List mode shows every chat on its own row, as before, and the header button switches", async () => {
    // The real setter also saves the choice to the server; the test only needs the switch.
    const chosen: string[] = [];
    const realSetter = useSettingsStore.getState().setChatHistoryViewMode;
    useSettingsStore.setState({
      chatHistoryViewMode: "flat",
      setChatHistoryViewMode: (mode) => { chosen.push(mode); useSettingsStore.setState({ chatHistoryViewMode: mode }); },
    });
    try {
      view = await mount(<SessionHistoryList projectName="ppm" variant="sidebar" />);
      expect(toggle()).toBeNull();
      expect(text()).not.toContain("sub-chat");
      expect(text().indexOf("Task 2")).toBeLessThan(text().indexOf("Task 1"));
      expect(text().indexOf("Task 1")).toBeLessThan(text().indexOf("Search spec"));

      await click(view.container.querySelector('button[aria-label="Show as a tree"]'));
      expect(chosen).toEqual(["tree"]);
      expect(text()).toContain("2 sub-chats");
    } finally {
      useSettingsStore.setState({ setChatHistoryViewMode: realSetter });
    }
  });

  it("a spec's chat shows the spec's progress and lists running and failed task chats first", async () => {
    specs = [{
      slug: "search", title: "Search", kind: "feature", checks: "standard", current: "execution",
      tasksDone: 1, tasksTotal: 3, red: 0, running: 1, waitingForYou: false, sessionId: "spec", updatedAt: "2026-11-10T00:00:00Z",
      tasks: [
        { id: "1", title: "Parse query", status: "done", optional: false, sessionId: "t1" },
        { id: "2", title: "Search history", status: "failed", optional: false, sessionId: "t2" },
        { id: "3", title: "E2e", status: "todo", optional: false, sessionId: null },
      ],
    }];
    view = await mount(<SessionHistoryList projectName="ppm" variant="sidebar" />);
    await act(async () => {});
    expect(text()).toContain("1/3 done");
    expect(text()).toContain("1 failed");
    expect(text()).not.toContain("sub-chat");
    expect(view.container.querySelectorAll(".bg-success, .bg-error, .bg-border").length).toBeGreaterThanOrEqual(3);

    await click(view.container.querySelector('button[aria-label="Show 2 task chats"]'));
    expect(text().indexOf("2. Search history")).toBeLessThan(text().indexOf("1. Parse query"));
    expect(view.container.querySelector('[aria-label="Failed"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Done"]')).not.toBeNull();
  });
});
