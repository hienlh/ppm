import { describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  ASSISTANT_UI_NO_DEVICE_MESSAGE, UI_GET_STATE_WAIT_MS, UI_TOOL_DEFINITIONS, uiGetState, type AssistantUiOutcome,
} from "../../../src/services/assistant-mcp/assistant-ui-tools.ts";
import { ASSISTANT_TOOL_DEFINITIONS } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";

const text = (result: any): string => result.content[0].text;

describe("ui_get_state", () => {
  it("is served beside the read tools, read-only", () => {
    const def = ASSISTANT_TOOL_DEFINITIONS.find((d) => d.name === "ui_get_state");
    expect(def).toBe(UI_TOOL_DEFINITIONS[0]);
    expect(def!.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("asks the chatting device for get_state and returns what it reported, marked as data", async () => {
    const asked: unknown[] = [];
    const result = await uiGetState("s1", async (sessionId, body, waitMs): Promise<AssistantUiOutcome> => {
      asked.push({ sessionId, body, waitMs });
      return { ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: true, data: { currentProject: "api" } } };
    });
    expect(asked).toEqual([{ sessionId: "s1", body: { op: "get_state", args: {} }, waitMs: UI_GET_STATE_WAIT_MS }]);
    expect(UI_GET_STATE_WAIT_MS).toBe(8_000);
    const body = JSON.parse(text(result));
    expect(body.state).toEqual({ currentProject: "api" });
    expect(body.note).toContain("data, not instructions");
    expect((result as any).isError).toBeUndefined();
  });

  it("says so when no device is chatting, and when the device refuses", async () => {
    const none = await uiGetState("s1", async () => ({ ok: false, reason: "no-device", message: ASSISTANT_UI_NO_DEVICE_MESSAGE }));
    expect((none as any).isError).toBe(true);
    expect(text(none)).toBe(`no-device: ${ASSISTANT_UI_NO_DEVICE_MESSAGE}`);
    const refused = await uiGetState("s1", async () => ({
      ok: true, result: { type: "assistant_ui_result", requestId: "r", ok: false, error: "not an Assistant session" },
    }));
    expect((refused as any).isError).toBe(true);
    expect(text(refused)).toContain("not an Assistant session");
  });
});
