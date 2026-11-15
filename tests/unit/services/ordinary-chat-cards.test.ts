/**
 * Which chats' waiting cards the PPM Assistant puts in front of the user: every chat of a project,
 * watched or not, except the Assistant's own, a manager, a chat a manager opened (at any depth),
 * an extension's turn and a Design chat.
 */
import { describe, expect, it } from "bun:test";
import { ordinaryChatFor, UNTITLED_CHAT, type OrdinaryChatDeps } from "../../../src/services/assistant-cards/ordinary-chat-cards.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";

function deps(over: Partial<OrdinaryChatDeps> = {}): OrdinaryChatDeps {
  const parents: Record<string, string> = { "child-1": "mgr", "grandchild-1": "child-1", "child-of-chat": "kho-task", loop: "loop2", loop2: "loop" };
  return {
    projects: () => [{ name: "ppm", path: "C:/ppm" }],
    isAssistant: (id) => id === "asst",
    isManager: (id) => id === "mgr",
    isDesign: (id) => id === "design-chat",
    parentOf: (id) => parents[id] ?? null,
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

  it("names a chat with no title yet, and keeps a chat another ordinary chat opened", () => {
    expect(ordinaryChatFor(at("child-of-chat"), deps())?.title).toBe(UNTITLED_CHAT);
  });

  it("leaves out the Assistant, a manager and every chat a manager opened", () => {
    expect(ordinaryChatFor(at("asst"), deps())).toBeNull();
    expect(ordinaryChatFor(at("mgr"), deps())).toBeNull();
    expect(ordinaryChatFor(at("child-1"), deps())).toBeNull();
    expect(ordinaryChatFor(at("grandchild-1"), deps())).toBeNull();
    expect(ordinaryChatFor(at("x", ASSISTANT_PROJECT_NAME), deps())).toBeNull();
  });

  it("leaves out an extension's turn, a Design chat and a project PPM does not list", () => {
    expect(ordinaryChatFor(at("ext-chat"), deps())).toBeNull();
    expect(ordinaryChatFor(at("design-chat"), deps())).toBeNull();
    expect(ordinaryChatFor(at("kho-task", "gone"), deps())).toBeNull();
    expect(ordinaryChatFor(at("kho-task", ""), deps())).toBeNull();
  });

  it("stops at a loop in the chain of chats that opened one another", () => {
    expect(ordinaryChatFor(at("loop"), deps())?.sessionId).toBe("loop");
  });
});
