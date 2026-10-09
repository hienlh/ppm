import { usePanelStore } from "@/stores/panel-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { isAssistantProject } from "../../../shared/assistant-project";
import type { AssistantUiOp, AssistantUiRequest, AssistantUiResult, UiSummary } from "../../../shared/assistant-ui-protocol";
import { buildUiStateSnapshot, type UiStateSnapshot } from "./ui-state-snapshot";
import { buildUiSummary } from "./ui-summary";

/**
 * The device half of the PPM Assistant's UI tools: answers the server's `assistant_ui` on the
 * chat socket. The server sends it only to the device that sent the Assistant session's latest
 * message; this side refuses it outright for any other chat, so a request that reached an
 * ordinary chat's socket — however it got there — reads and changes nothing.
 *
 * One handler per operation; an operation this build has no handler for is answered as
 * unsupported rather than ignored, so the agent is told instead of waiting out the timeout.
 */

type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** This device's layout, read from the stores as it is right now. */
export function readUiState(): UiStateSnapshot {
  const panels = usePanelStore.getState();
  return buildUiStateSnapshot({
    currentProject: panels.currentProject,
    layout: panels.isMobile() ? "phone" : "desktop",
    panels: panels.panels,
    grid: panels.grid,
    focusedPanelId: panels.focusedPanelId,
    dock: panels.dock,
    dockExpanded: panels.dockExpanded,
    windows: Object.values(useWindowStore.getState().windows),
  });
}

/** The summary an Assistant message carries; undefined when the screen cannot be read. */
export function readUiSummary(): UiSummary | undefined {
  try {
    return buildUiSummary(readUiState());
  } catch (e) {
    console.warn("[assistant-ui] could not summarise the screen:", e);
    return undefined;
  }
}

const HANDLERS: Partial<Record<AssistantUiOp, Handler>> = {
  get_state: () => readUiState(),
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function answerAssistantUi(
  req: AssistantUiRequest,
  chat: { projectName: string | undefined },
  send: (data: string) => void,
): Promise<void> {
  const reply = (answer: { ok: true; data: unknown } | { ok: false; error: string }): void => {
    const result: AssistantUiResult = { type: "assistant_ui_result", requestId: req.requestId, ...answer };
    send(JSON.stringify(result));
  };
  if (!isAssistantProject(chat.projectName)) {
    reply({ ok: false, error: "This chat is not a PPM Assistant session; its device does not take Assistant requests." });
    return;
  }
  const handler = HANDLERS[req.op];
  if (!handler) {
    reply({ ok: false, error: `This PPM build does not support "${String(req.op).slice(0, 40)}" on the device.` });
    return;
  }
  try {
    reply({ ok: true, data: await handler(req.args && typeof req.args === "object" ? req.args : {}) });
  } catch (e) {
    reply({ ok: false, error: errorText(e) });
  }
}
