import { describe, expect, it } from "bun:test";
import {
  ASSISTANT_UI_OPS, MAX_ASSISTANT_UI_DATA_CHARS, MAX_ASSISTANT_UI_ERROR_CHARS, isAssistantUiOp, parseAssistantUiResult,
} from "../../../src/shared/assistant-ui-protocol.ts";

const ID = "AbCdEfGhIjKlMnOp";

describe("assistant UI protocol", () => {
  it("names every operation the device may be asked for", () => {
    expect([...ASSISTANT_UI_OPS]).toEqual([
      "get_state", "open_tab", "focus_tab", "close_tab", "switch_project", "describe_tab", "list_commands", "run_command",
    ]);
    expect(isAssistantUiOp("get_state")).toBe(true);
    expect(isAssistantUiOp("eval")).toBe(false);
    expect(isAssistantUiOp(1)).toBe(false);
  });

  it("accepts a device's data and its refusal", () => {
    expect(parseAssistantUiResult({ type: "assistant_ui_result", requestId: ID, ok: true, data: { a: 1 } }))
      .toEqual({ type: "assistant_ui_result", requestId: ID, ok: true, data: { a: 1 } });
    expect(parseAssistantUiResult({ type: "assistant_ui_result", requestId: ID, ok: false, error: "not an Assistant session" }))
      .toEqual({ type: "assistant_ui_result", requestId: ID, ok: false, error: "not an Assistant session" });
  });

  it("drops extra fields, cuts a long error and names a missing one", () => {
    const long = parseAssistantUiResult({ type: "assistant_ui_result", requestId: ID, ok: false, error: "x".repeat(2_000), extra: 1 });
    expect(long).toEqual({ type: "assistant_ui_result", requestId: ID, ok: false, error: "x".repeat(MAX_ASSISTANT_UI_ERROR_CHARS) });
    expect(parseAssistantUiResult({ type: "assistant_ui_result", requestId: ID, ok: false }))
      .toMatchObject({ ok: false, error: "The device could not do this." });
  });

  it("refuses anything malformed or oversized", () => {
    const bad: unknown[] = [
      null, "x", [], {},
      { type: "tab_open_result", requestId: ID, ok: true, data: 1 },
      { type: "assistant_ui_result", requestId: "short", ok: true, data: 1 },
      { type: "assistant_ui_result", requestId: "../../../../etc/pass", ok: true, data: 1 },
      { type: "assistant_ui_result", requestId: ID, ok: "yes", data: 1 },
      { type: "assistant_ui_result", requestId: ID, ok: true },
      { type: "assistant_ui_result", requestId: ID, ok: true, data: "y".repeat(MAX_ASSISTANT_UI_DATA_CHARS + 1) },
    ];
    for (const raw of bad) expect(parseAssistantUiResult(raw)).toBeNull();
  });
});
