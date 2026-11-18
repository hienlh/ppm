import { describe, expect, test } from "bun:test";
import { planChatOpen } from "../../../src/web/lib/chat-open-plan";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project";

describe("planChatOpen", () => {
  test("a chat of the project on screen opens as a tab, as before", () => {
    expect(planChatOpen({ projectName: "ppm", activeProject: "ppm", mobile: false })).toBe("here");
    expect(planChatOpen({ projectName: "ppm", activeProject: "ppm", mobile: true })).toBe("here");
  });

  test("on a desktop, another project's chat opens in a floating window", () => {
    expect(planChatOpen({ projectName: "ppm", activeProject: "nxsys", mobile: false })).toBe("window");
  });

  test("on a phone, where there are no windows, the screen switches to the chat's project", () => {
    expect(planChatOpen({ projectName: "ppm", activeProject: "nxsys", mobile: true })).toBe("switch");
  });

  test("with no project on screen there is nothing to keep, so the project switches", () => {
    expect(planChatOpen({ projectName: "ppm", activeProject: null, mobile: false })).toBe("switch");
  });

  test("a PPM Assistant session opens in the Assistant, wherever the user is", () => {
    for (const mobile of [false, true]) {
      expect(planChatOpen({ projectName: ASSISTANT_PROJECT_NAME, activeProject: "nxsys", mobile })).toBe("assistant");
      expect(planChatOpen({ projectName: ASSISTANT_PROJECT_NAME, activeProject: null, mobile })).toBe("assistant");
    }
  });

  test("project names are compared exactly", () => {
    expect(planChatOpen({ projectName: "PPM", activeProject: "ppm", mobile: false })).toBe("window");
  });
});
