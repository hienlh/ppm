import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const initialPanels = usePanelStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  localStorage.clear();
  uninstallDom();
});
const { answerAssistantUi, readUiSummary } = await import("../../../src/web/lib/assistant-ui/answer-assistant-ui");

const ID = "AbCdEfGhIjKlMnOp";

async function ask(op: string, projectName: string | undefined) {
  const sent: any[] = [];
  await answerAssistantUi({ type: "assistant_ui", requestId: ID, op: op as any, args: {} }, { projectName }, (m) => sent.push(JSON.parse(m)));
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe("answering the Assistant's UI requests on the device", () => {
  it("reads this device's layout for an Assistant session", async () => {
    const answer = await ask("get_state", "__assistant__");
    expect(answer).toMatchObject({ type: "assistant_ui_result", requestId: ID, ok: true });
    expect(answer.data).toHaveProperty("panels");
    expect(answer.data).toHaveProperty("windows");
    expect(answer.data.currentProject).toBe(usePanelStore.getState().currentProject);
  });

  it("refuses for any other chat", async () => {
    for (const project of ["api", undefined]) {
      const answer = await ask("get_state", project);
      expect(answer).toMatchObject({ ok: false });
      expect(answer.error).toContain("not a PPM Assistant session");
      expect(answer.data).toBeUndefined();
    }
  });

  it("answers an operation it has no handler for instead of staying silent", async () => {
    // An op a newer server may send that this build has no handler for.
    const answer = await ask("no_such_op", "__assistant__");
    expect(answer).toMatchObject({ ok: false });
    expect(answer.error).toContain("does not support");
  });

  it("summarises the screen for an outgoing message", () => {
    const summary = readUiSummary();
    expect(summary).toBeDefined();
    expect(Array.isArray(summary!.panels)).toBe(true);
    expect(summary!.layout === "phone" || summary!.layout === "desktop").toBe(true);
  });
});
