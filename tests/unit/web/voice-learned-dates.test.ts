import { describe, expect, it } from "bun:test";
import { learnedDates, learningLabel } from "../../../src/web/components/settings/voice-learned-words-list";

describe("learningLabel", () => {
  it("counts chats for the chat's readings and sightings for the clean-up's", () => {
    const at = new Date(2026, 10, 20).toISOString();
    expect(learningLabel({ from: "BPM", to: "PPM", hits: 2, at, source: "chat", chats: 2 })).toBe("chat · 2 of 3 chats");
    expect(learningLabel({ from: "scale", to: "Slack", hits: 1, at, source: "cleanup", chats: 0 })).toBe("clean-up · seen 1×");
  });
});

const NOW = new Date(2026, 10, 21, 9, 0);
describe("learnedDates", () => {
  it("shows the last use once the word was said after it was learned, with both dates in the title", () => {
    const d = learnedDates({ word: "PPM", from: "BPM", at: new Date(2026, 10, 10, 8, 0).toISOString(), lastUsedAt: new Date(2026, 10, 21, 3, 9).toISOString() }, NOW);
    expect(d.text).toBe("used today 03:09");
    expect(d.title).toStartWith("learned ");
    expect(d.title).toEndWith("last used today 03:09");
  });

  it("shows when it was learned while it has not been used since", () => {
    expect(learnedDates({ word: "PPM", from: "BPM", at: new Date(2026, 10, 20, 8, 0).toISOString() }, NOW).text).toBe("learned yesterday");
  });
});
