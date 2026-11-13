/**
 * The AI tab tools belong to ordinary chats; a PPM Assistant session drives the screen through
 * its own UI tools, which ask first. A `tab_open` that reached an Assistant chat's socket,
 * however it got there, opens nothing and says so, so the waiting tool call is answered — except
 * the terminal of the Assistant's own `terminal_type`, which docks in the project the device
 * shows (the Assistant's own project is no workspace) and is marked as typed by an AI.
 */
import { afterAll, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { answerTabOpen } = await import("../../../src/web/lib/open-ai-tab");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { ASSISTANT_PROJECT_NAME } = await import("../../../src/shared/assistant-project");
afterAll(() => uninstallDom());

const assistantChat = { sessionId: "s-1", projectName: ASSISTANT_PROJECT_NAME };
const terminalReq = { type: "tab_open", requestId: "t-2", tool: "run_in_terminal", terminalId: "term-1", projectName: "api", cwd: "/work/api/scripts" };

it("refuses a tab_open on an Assistant chat without touching the layout", async () => {
  const openTab = spyOn(usePanelStore.getState(), "openTab");
  const openInDock = spyOn(usePanelStore.getState(), "openInDock");
  const sent: string[] = [];
  try {
    await answerTabOpen(
      { type: "tab_open", requestId: "t-1", tool: "open_file", filePath: "README.md", projectName: "web" } as never,
      assistantChat,
      (data) => sent.push(data),
    );
    // An ordinary chat's terminal request is no exception either: only the docked-where-the-user-is one is.
    await answerTabOpen(terminalReq as never, assistantChat, (data) => sent.push(data));
    expect(openTab).not.toHaveBeenCalled();
    expect(openInDock).not.toHaveBeenCalled();
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { type: "tab_open_result", requestId: "t-1", opened: false, error: expect.stringContaining("PPM Assistant") },
      { type: "tab_open_result", requestId: "t-2", opened: false, error: expect.stringContaining("PPM Assistant") },
    ]);
  } finally {
    openTab.mockRestore();
    openInDock.mockRestore();
  }
});

it("docks the Assistant's terminal in the project the device shows, marked as typed by an AI, and says which", async () => {
  usePanelStore.setState({ currentProject: "web" });
  const switchProject = spyOn(usePanelStore.getState(), "switchProject");
  const opened: Array<Record<string, unknown>> = [];
  const openInDock = spyOn(usePanelStore.getState(), "openInDock").mockImplementation((def) => {
    opened.push(def as Record<string, unknown>);
    return "terminal:7";
  });
  const sent: string[] = [];
  try {
    await answerTabOpen({ ...terminalReq, dock: "current" } as never, assistantChat, (data) => sent.push(data));
    expect(switchProject).not.toHaveBeenCalled();
    expect(opened).toEqual([{
      type: "terminal", title: "scripts", projectId: "web", closable: true,
      metadata: { sessionId: "term-1", cwd: "/work/api/scripts", aiMark: true, projectName: "api" },
    }]);
    expect(sent.map((s) => JSON.parse(s))).toEqual([{ type: "tab_open_result", requestId: "t-2", opened: true, shownProject: "web" }]);
  } finally {
    switchProject.mockRestore();
    openInDock.mockRestore();
  }
});
