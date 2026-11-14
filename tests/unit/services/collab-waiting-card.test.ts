import { describe, expect, it } from "bun:test";
import { cardRaisedFor, waitingCardOf } from "../../../src/services/session-collab/collab-waiting-card.ts";
import { WAITING_CARD_TITLE_MAX } from "../../../src/shared/session-collab.ts";

describe("waitingCardOf", () => {
  it("names a question card by its first question, and says how many more it holds", () => {
    const card = waitingCardOf({
      tool: "AskUserQuestion",
      input: { questions: [{ question: "Release done.\nWhich clean-up first?", options: [] }, { question: "Close the sprint?", options: [] }] },
    });
    expect(card).toEqual({ kind: "question", title: "Release done. Which clean-up first? (+1 more)" });
  });

  it("prefers the normalized questions a card already carries", () => {
    expect(waitingCardOf({ tool: "AskUserQuestion", input: {}, questions: [{ question: "Which branch?" }] }))
      .toEqual({ kind: "question", title: "Which branch?" });
  });

  it("names an approval by its summary's headline, else by its tool", () => {
    expect(waitingCardOf({ tool: "ppm_db_execute", summary: { headline: "Run 2 statements on prod" } }))
      .toEqual({ kind: "approval", title: "Run 2 statements on prod" });
    expect(waitingCardOf({ tool: "Bash", input: { command: "rm -rf x" } })).toEqual({ kind: "approval", title: "Bash" });
  });

  it("names PPM's own cards in words, and says whom a session tool's card would message", () => {
    const pairLimit = { tool: "ppm:session_collab", input: { kind: "pair_limit", targetSessionId: "s-a", targetTitle: "A", sent: 5, limit: 5, grant: 5 } };
    expect(waitingCardOf(pairLimit)).toEqual({ kind: "approval", title: "Sessions reached their message limit (5/5)" });
    expect(cardRaisedFor(pairLimit)).toBe("s-a");
    expect(waitingCardOf({ tool: "ppm:db_execute", input: {} })).toEqual({ kind: "approval", title: "A database change" });
    expect(cardRaisedFor({ tool: "ppm:session_collab", input: { kind: "create", title: "Child" } })).toBeNull();
    expect(cardRaisedFor({ tool: "Bash", input: { targetSessionId: "s-a" } })).toBeNull();
  });

  it("keeps another AI's words to one short line with its code fences broken", () => {
    const card = waitingCardOf({ tool: "AskUserQuestion", input: { questions: [{ question: `\`\`\`\n${"x".repeat(400)}`, options: [] }] } });
    expect(card.title.length).toBeLessThanOrEqual(WAITING_CARD_TITLE_MAX + 4);
    expect(card.title).not.toContain("```");
    expect(card.title).not.toContain("\n");
  });
});
