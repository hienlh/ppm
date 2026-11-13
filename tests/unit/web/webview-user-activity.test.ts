import { describe, expect, test } from "bun:test";
import { isUserActivityMessage, USER_ACTIVITY_COMMAND } from "../../../src/web/components/extensions/webview-user-activity";

describe("a webview's claim that a person just interacted with it", () => {
  test("the explicit activity message is recognised", () => {
    expect(isUserActivityMessage({ command: USER_ACTIVITY_COMMAND })).toBe(true);
  });

  test("ordinary protocol traffic never counts: a request/response round trip, a file-icon request, anything else", () => {
    for (const data of [
      { command: "graph:get", id: 1 },
      { type: "response", id: 1, result: {} },
      { command: "__ppm.getFileIcons", names: ["a.ts"] },
      { command: "ready" },
      "a string message",
      null,
      undefined,
      42,
    ]) {
      expect(isUserActivityMessage(data)).toBe(false);
    }
  });
});
