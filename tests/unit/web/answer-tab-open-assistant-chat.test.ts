/**
 * The AI tab tools belong to ordinary chats; a PPM Assistant session drives the screen through
 * its own UI tools, which ask first. A `tab_open` that reached an Assistant chat's socket,
 * however it got there, opens nothing and says so, so the waiting tool call is answered.
 */
import { expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { answerTabOpen } = await import("../../../src/web/lib/open-ai-tab");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { ASSISTANT_PROJECT_NAME } = await import("../../../src/shared/assistant-project");

it("refuses a tab_open on an Assistant chat without touching the layout", async () => {
  const openTab = spyOn(usePanelStore.getState(), "openTab");
  const sent: string[] = [];
  try {
    await answerTabOpen(
      { type: "tab_open", requestId: "t-1", tool: "open_file", filePath: "README.md", projectName: "web" } as never,
      { sessionId: "s-1", projectName: ASSISTANT_PROJECT_NAME },
      (data) => sent.push(data),
    );
    expect(openTab).not.toHaveBeenCalled();
    expect(sent.map((s) => JSON.parse(s))).toEqual([
      { type: "tab_open_result", requestId: "t-1", opened: false, error: expect.stringContaining("PPM Assistant") },
    ]);
  } finally {
    openTab.mockRestore();
    uninstallDom();
  }
});
