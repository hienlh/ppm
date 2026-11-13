/**
 * A chat tab keeps the id it was opened with when its session is switched in place — the tab's
 * own History list does that, and so does a cleared or migrated session. On 2026-11-03 the tab
 * opened for Task A had been switched to Task B, so clicking Task A in Chat History matched
 * that tab by its id and focused Task B: the session could not be opened at all, and nothing
 * on screen said why. A notification for it, or its URL, landed on the same wrong tab.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { openSessionInItsTab } = await import("../../../src/web/lib/design/open-design-tab");
const { autoOpenFromUrl, buildUrl, urlTabId } = await import("../../../src/web/hooks/use-url-sync");
const { tabSessionId } = await import("../../../src/web/lib/tab-session-id");

/** The session the tab was opened with, and the one it was switched to. */
const OPENED_FOR = "4ca3335a-0d87-4aef-bba0-d367aa389c58";
const SHOWS = "a5c518d7-7065-4ed6-aa0a-9b6abe883576";

const switched = {
  id: `chat:claude/${OPENED_FOR}`, type: "chat" as const, title: "Task B", projectId: "p", closable: true,
  metadata: { projectName: "p", providerId: "claude", sessionId: SHOWS },
};
const editor = { id: "editor:a.ts", type: "editor" as const, title: "a.ts", projectId: "p", closable: true, metadata: { filePath: "a.ts" } };

beforeEach(() => {
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {},
    panels: { main: { id: "main", activeTabId: editor.id, tabHistory: [editor.id], tabs: [switched, editor] } },
  } as never);
});

const panel = () => usePanelStore.getState().panels.main!;
const activeTab = () => panel().tabs.find((t) => t.id === panel().activeTabId);

describe("a chat tab whose session was switched in place", () => {
  it("does not stand in for the session it was opened with, from Chat History", () => {
    openSessionInItsTab({ id: OPENED_FOR, providerId: "claude", title: "Task A" }, "p");
    expect(tabSessionId(activeTab())).toBe(OPENED_FOR);
    expect(tabSessionId(panel().tabs.find((t) => t.id === switched.id))).toBe(SHOWS);
    expect(new Set(panel().tabs.map((t) => t.id)).size).toBe(panel().tabs.length);
  });

  it("does not stand in for it from a notification or a URL either", () => {
    autoOpenFromUrl("chat", `claude/${OPENED_FOR}`, "p");
    expect(tabSessionId(activeTab())).toBe(OPENED_FOR);
  });

  it("is still the tab for the session it shows", () => {
    openSessionInItsTab({ id: SHOWS, providerId: "claude" }, "p");
    expect(panel().activeTabId).toBe(switched.id);
    autoOpenFromUrl("chat", `claude/${SHOWS}`, "p");
    expect(panel().activeTabId).toBe(switched.id);
    expect(panel().tabs).toHaveLength(2);
  });

  it("opens the session it was opened with only once", () => {
    const first = openSessionInItsTab({ id: OPENED_FOR, providerId: "claude" }, "p");
    usePanelStore.getState().setActiveTab(editor.id);
    expect(openSessionInItsTab({ id: OPENED_FOR, providerId: "claude" }, "p")).toBe(first);
    expect(panel().tabs).toHaveLength(3);
  });

  it("puts the session it shows in the URL, so a reload reopens what was on screen", () => {
    expect(buildUrl("p", urlTabId(switched))).toBe(`/project/p/chat/claude/${SHOWS}`);
  });
});
