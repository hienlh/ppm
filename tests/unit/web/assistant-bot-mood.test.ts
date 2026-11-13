import { describe, expect, it } from "bun:test";
import { assistantBotMood } from "../../../src/web/lib/assistant-bot-mood.ts";

describe("the Assistant robot's mood", () => {
  it("idles with nothing going on, and smiles while its window is open", () => {
    expect(assistantBotMood({ waiting: 0, thinking: false, shown: false })).toBe("idle");
    expect(assistantBotMood({ waiting: 0, thinking: false, shown: true })).toBe("happy");
  });

  it("thinks while its main session runs a turn, open or not", () => {
    expect(assistantBotMood({ waiting: 0, thinking: true, shown: false })).toBe("thinking");
    expect(assistantBotMood({ waiting: 0, thinking: true, shown: true })).toBe("thinking");
  });

  it("calls for the user above everything else while cards wait", () => {
    expect(assistantBotMood({ waiting: 2, thinking: true, shown: true })).toBe("waiting");
  });
});
