import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { isPublicHttpsUrl, placeLink } from "../../../../src/services/assistant-telegram/assistant-telegram-links.ts";
import { notificationPath } from "../../../../src/services/notification-format.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../../src/shared/assistant-project.ts";

describe("links back into the Assistant", () => {
  it("opens an Assistant session in the Assistant, not as a chat of the first project", () => {
    expect(notificationPath({ project: ASSISTANT_PROJECT_NAME, sessionId: "abc", providerId: "codex" })).toBe("/assistant?session=codex%2Fabc");
    expect(notificationPath({ project: ASSISTANT_PROJECT_NAME, sessionId: "abc" })).toBe("/assistant?session=abc");
    expect(notificationPath({ project: ASSISTANT_PROJECT_NAME, sessionId: "" })).toBe("/assistant");
    // Ordinary chats are unchanged.
    expect(notificationPath({ project: "ppm", sessionId: "s1", providerId: "claude" })).toBe("/project/ppm?openChat=claude%2Fs1");
  });

  it("makes a button only of a public https address", () => {
    expect(isPublicHttpsUrl("https://quiet-river-bend.trycloudflare.com/assistant")).toBe(true);
    expect(isPublicHttpsUrl("https://ppm.tail1234.ts.net/assistant")).toBe(true);
    for (const url of [
      "http://localhost:8080/assistant", "https://localhost:8080/", "https://127.0.0.1/", "https://192.168.1.4/",
      "https://10.0.0.2/", "https://[::1]:8080/", "https://ppm/", "http://ppm.example.com/", "https://user:pw@ppm.example.com/", "not a url",
    ]) expect(isPublicHttpsUrl(url)).toBe(false);
  });

  it("puts a local link in the text, escaped", () => {
    expect(placeLink("http://localhost:8080/assistant?session=claude/a&b")).toEqual({
      inline: "Open in PPM: http://localhost:8080/assistant?session=claude/a&amp;b",
    });
    expect(placeLink("https://ppm.tail1234.ts.net/assistant")).toEqual({
      button: { text: "Open in PPM", url: "https://ppm.tail1234.ts.net/assistant" },
    });
  });
});
