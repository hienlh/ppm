/**
 * A design session lives in its design tab. Anything that opens the session as a chat — a
 * notification, the history list, a `?openChat=` link — must land on that tab, not start a
 * plain chat tab that has left design mode.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { openDesignTab, openSessionInItsTab } = await import("../../../src/web/lib/design/open-design-tab");

const designTab = (id: string, project: string, slug: string, sessionId?: string) => ({
  id, type: "design" as const, title: slug, projectId: project, closable: true,
  metadata: { projectName: project, designSlug: slug, ...(sessionId ? { sessionId } : {}), designChatEpoch: 2 },
});
const editorTab = { id: "editor:a.ts", type: "editor" as const, title: "a.ts", projectId: "p", closable: true, metadata: { filePath: "a.ts" } };

beforeEach(() => {
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left", "right"]], lastFocusedChatProviders: {},
    panels: {
      left: { id: "left", activeTabId: editorTab.id, tabHistory: [editorTab.id], tabs: [editorTab] },
      right: { id: "right", activeTabId: "x", tabHistory: [], tabs: [
        { id: "x", type: "editor", title: "x", projectId: "p", closable: true, metadata: { filePath: "x" } },
        designTab("design:landing", "p", "landing", "sess-1"),
      ] },
    },
  } as never);
});

const allTabs = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs);

describe("opening a design session", () => {
  it("focuses the design tab when the session is opened as a chat", () => {
    const id = usePanelStore.getState().openTab({
      type: "chat", title: "Chat", projectId: "p", closable: true, metadata: { projectName: "p", sessionId: "sess-1" },
    });
    expect(id).toBe("design:landing");
    expect(usePanelStore.getState().panels.right!.activeTabId).toBe("design:landing");
    expect(allTabs().filter((t) => t.type === "chat")).toHaveLength(0);
  });

  it("focuses the one design tab instead of opening a second, across panels", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing" });
    expect(id).toBe("design:landing");
    expect(allTabs().filter((t) => t.type === "design")).toHaveLength(1);
  });

  it("does not confuse another project's design with the same slug", () => {
    usePanelStore.setState((s) => ({ panels: { ...s.panels, right: { ...s.panels.right!, tabs: [designTab("design:landing", "other", "landing")] } } }));
    openDesignTab({ projectName: "p", slug: "landing" });
    expect(allTabs().filter((t) => t.type === "design")).toHaveLength(2);
  });

  it("switches the open design tab to a session picked from history and remounts its chat", () => {
    openSessionInItsTab({ id: "sess-2", providerId: "codex", designSlug: "landing" }, "p");
    const tab = allTabs().find((t) => t.id === "design:landing")!;
    expect(tab.metadata!.sessionId).toBe("sess-2");
    expect(tab.metadata!.providerId).toBe("codex");
    expect(tab.metadata!.designChatEpoch).toBe(3);
    expect(tab.metadata!.designSlug).toBe("landing");
  });

  it("opens an ordinary session as an ordinary chat", () => {
    const id = openSessionInItsTab({ id: "plain", providerId: "claude", title: "Hi" }, "p");
    expect(allTabs().find((t) => t.id === id)?.type).toBe("chat");
  });
});
