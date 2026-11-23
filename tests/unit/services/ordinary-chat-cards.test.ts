/**
 * Which chats' waiting cards the PPM Assistant puts in front of the user: every chat of a project,
 * watched or not, and whoever opened it (a manager chat too, at any depth), except the Assistant's
 * own, a manager, an extension's turn and a Design chat.
 */
import { describe, expect, it } from "bun:test";
import { ordinaryChatFor, UNTITLED_CHAT, type OrdinaryChatDeps } from "../../../src/services/assistant-cards/ordinary-chat-cards.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";

function deps(over: Partial<OrdinaryChatDeps> = {}): OrdinaryChatDeps {
  return {
    projects: () => [{ name: "ppm", path: "C:/ppm" }],
    isAssistant: (id) => id === "asst",
    isManager: (id) => id === "mgr",
    isDesign: (id) => id === "design-chat",
    turnOrigin: (id) => (id === "ext-chat" ? "extension" : "ws"),
    title: (id) => (id === "kho-task" ? "  Kho   task " : null),
    ...over,
  };
}

const at = (sessionId: string, projectName = "ppm") => ({ sessionId, projectName, providerId: "claude" });

describe("ordinary chats whose cards the Assistant shows", () => {
  it("takes a chat the user opened, named as PPM shows it, with its project's path", () => {
    expect(ordinaryChatFor(at("kho-task"), deps())).toEqual({
      projectName: "ppm", projectPath: "C:/ppm", sessionId: "kho-task", title: "Kho task", providerId: "claude",
    });
  });

  it("names a chat with no title yet", () => {
    expect(ordinaryChatFor(at("child-of-chat"), deps())?.title).toBe(UNTITLED_CHAT);
  });

  it("takes a chat a manager opened, and its children at any depth, so their cards are not left to the manager", () => {
    expect(ordinaryChatFor(at("child-1"), deps())).toMatchObject({ sessionId: "child-1", projectName: "ppm", title: UNTITLED_CHAT });
    expect(ordinaryChatFor(at("grandchild-1"), deps())?.sessionId).toBe("grandchild-1");
  });

  it("leaves out the Assistant and a manager", () => {
    expect(ordinaryChatFor(at("asst"), deps())).toBeNull();
    expect(ordinaryChatFor(at("mgr"), deps())).toBeNull();
    expect(ordinaryChatFor(at("x", ASSISTANT_PROJECT_NAME), deps())).toBeNull();
  });

  it("leaves out an extension's turn, a Design chat and a project PPM does not list", () => {
    expect(ordinaryChatFor(at("ext-chat"), deps())).toBeNull();
    expect(ordinaryChatFor(at("design-chat"), deps())).toBeNull();
    expect(ordinaryChatFor(at("kho-task", "gone"), deps())).toBeNull();
    expect(ordinaryChatFor(at("kho-task", ""), deps())).toBeNull();
  });
});
