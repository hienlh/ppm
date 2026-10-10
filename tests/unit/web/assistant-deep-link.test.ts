/**
 * `/assistant?session=<provider>/<id>` — what Telegram's "Open in PPM" and a notification about
 * an Assistant session link to — opens the Assistant on that session over the project on screen.
 * The older `/project/__assistant__?openChat=…` used to fall through to the first registered
 * project and open the session there as an ordinary chat; it now lands in the Assistant too, and
 * never names a project or a chat to open.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
// Both stores outlive this file in the test process: put back what they were.
const initialPanels = usePanelStore.getState();
const initialWindows = useWindowStore.getState();
const initialWidth = window.innerWidth;
afterAll(() => {
  Object.defineProperty(window, "innerWidth", { value: initialWidth, configurable: true });
  usePanelStore.setState(initialPanels, true);
  useWindowStore.setState(initialWindows, true);
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  uninstallDom();
});
const { parseUrlState, openAssistantFromAddress } = await import("../../../src/web/hooks/use-url-sync");
const { assistantLinkFromLocation, parseAssistantSessionRef } = await import("../../../src/web/lib/assistant-deep-link");
const { ASSISTANT_TAB_ID } = await import("../../../src/web/components/assistant/open-assistant");

function at(address: string) {
  window.history.replaceState(null, "", address);
  return parseUrlState();
}

describe("reading an Assistant address", () => {
  it("names the session and its provider", () => {
    expect(at("/assistant?session=claude%2Fs-9")).toEqual({
      projectName: null, tabType: null, tabIdentifier: null, openChat: null,
      assistant: { sessionId: "s-9", providerId: "claude" },
    });
    expect(at("/assistant?session=codex/0199-abc").assistant).toEqual({ sessionId: "0199-abc", providerId: "codex" });
    expect(at("/assistant/").assistant).toEqual({});
    expect(at("/assistant").assistant).toEqual({});
  });

  it("turns the old virtual-project link into an Assistant one, naming no project or chat", () => {
    for (const address of [
      "/project/__assistant__?openChat=codex%2Fs-2",
      "/project/%5F%5Fassistant%5F%5F?openChat=codex%2Fs-2",
      "/project/__assistant__/chat/codex/s-2",
    ]) {
      expect(at(address)).toEqual({
        projectName: null, tabType: null, tabIdentifier: null, openChat: null,
        assistant: { sessionId: "s-2", providerId: "codex" },
      });
    }
    expect(at("/project/__assistant__").assistant).toEqual({});
  });

  it("leaves every other address alone", () => {
    expect(at("/project/ppm?openChat=claude%2Fabc")).toMatchObject({ projectName: "ppm", openChat: "claude/abc", assistant: null });
    expect(at("/project/ppm/assistant")).toMatchObject({ projectName: "ppm", tabType: "assistant", assistant: null });
    expect(at("/assistants")).toMatchObject({ projectName: null, assistant: null });
    expect(assistantLinkFromLocation("/", "?session=claude/x")).toBeNull();
  });

  it("opens the Assistant as it is when the session is not one, and drops a provider it cannot run", () => {
    expect(parseAssistantSessionRef("claude/../../etc")).toEqual({});
    expect(parseAssistantSessionRef("claude/a b")).toEqual({});
    expect(parseAssistantSessionRef("")).toEqual({});
    expect(parseAssistantSessionRef(null)).toEqual({});
    expect(parseAssistantSessionRef("cursor/abc")).toEqual({ sessionId: "abc" });
    expect(parseAssistantSessionRef("abc")).toEqual({ sessionId: "abc" });
  });
});

describe("opening it", () => {
  const editor = (id: string, project: string) => ({
    id, type: "editor" as const, title: id, projectId: project, closable: true, metadata: { filePath: id, projectName: project },
  });
  const assistantTab = (sessionId: string) => ({
    id: ASSISTANT_TAB_ID, type: "assistant" as const, title: "PPM Assistant", projectId: null, closable: true,
    metadata: { projectName: "__assistant__", providerId: "claude", sessionId, assistantChatEpoch: 1 },
  });

  function seed(mobile: boolean, withAssistant: boolean) {
    const visible = {
      id: "b1", activeTabId: "editor:b.ts", tabHistory: [],
      tabs: [editor("editor:b.ts", "b"), ...(withAssistant ? [assistantTab("s1")] : [])],
    };
    usePanelStore.setState({
      currentProject: "b", focusedPanelId: "b1", grid: [["b1"]], lastFocusedChatProviders: {},
      projectGrids: {}, projectFocused: {}, panels: { b1: visible },
      isMobile: () => mobile,
    } as never);
    useWindowStore.setState({ restored: true } as never);
    Object.defineProperty(window, "innerWidth", { value: mobile ? 390 : 1366, configurable: true });
  }

  const tabs = () => Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs);
  const assistant = () => tabs().find((t) => t.id === ASSISTANT_TAB_ID);

  beforeEach(() => localStorage.clear());

  for (const mobile of [true, false]) {
    const device = mobile ? "phone" : "desktop";

    it(`switches an open Assistant to the linked session, on the project on screen (${device})`, () => {
      seed(mobile, true);
      const link = at("/assistant?session=codex%2Fs-9").assistant!;
      openAssistantFromAddress(link);
      expect(assistant()?.metadata).toMatchObject({ sessionId: "s-9", providerId: "codex", projectName: "__assistant__" });
      expect(usePanelStore.getState().currentProject).toBe("b");
      // No chat tab of any project was opened for it.
      expect(tabs().filter((t) => t.type === "chat")).toEqual([]);
      expect(window.location.pathname).toBe("/");
    });

    it(`opens a closed Assistant on the session an old link names (${device})`, () => {
      seed(mobile, false);
      openAssistantFromAddress(at("/project/__assistant__?openChat=claude%2Fs-3").assistant!);
      expect(assistant()?.metadata).toMatchObject({ sessionId: "s-3", providerId: "claude" });
      expect(usePanelStore.getState().currentProject).toBe("b");
      expect(tabs().filter((t) => t.type === "chat")).toEqual([]);
    });
  }
});
