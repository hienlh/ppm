/**
 * A held rules change reaches its card as the whole change, in file order — the same lines
 * Settings shows — never only the lines that made PPM hold it. Approve may be offered from the card
 * only when the card holds every line, uncut and unaltered; an empty or partial change is decided
 * in Settings.
 */
import { describe, expect, it } from "bun:test";
import { heldChangeLines } from "../../../src/services/assistant-managers/manager-rules-diff.ts";
import { heldChangePayload } from "../../../src/services/assistant-cards/assistant-event-cards.ts";

const RULES = "# Rules\n\nNever merge to master without the user's OK.\nAsk before emailing a client.\n";

describe("the held change a rules card shows", () => {
  it("shows a removal as a removal", () => {
    const next = "# Rules\n\nAsk before emailing a client.\n";
    const diff = heldChangeLines(RULES, next);
    expect(diff).toEqual([{ op: "remove", line: "Never merge to master without the user's OK." }]);
    expect(heldChangePayload(diff)).toEqual({ changes: diff!, rulesComplete: true });
  });

  it("shows every added line, not only the one that held the change", () => {
    const next = `${RULES}Deploys to staging need no OK unless asked.\nKeep PRs small.\n`;
    expect(heldChangeLines(RULES, next)).toEqual([
      { op: "add", line: "Deploys to staging need no OK unless asked." },
      { op: "add", line: "Keep PRs small." },
    ]);
  });

  it("keeps file order when lines are removed and added", () => {
    const next = "# Rules\n\nMerge to master when green.\nAsk before emailing a client.\n";
    // The replaced line sits where it was: the new line, then the line it replaced.
    expect(heldChangeLines(RULES, next)).toEqual([
      { op: "add", line: "Merge to master when green." },
      { op: "remove", line: "Never merge to master without the user's OK." },
    ]);
  });

  it("offers nothing to approve for a file with no rule line", () => {
    const diff = heldChangeLines(RULES, "\n  \n");
    expect(diff).toBeNull();
    expect(heldChangePayload(diff)).toEqual({ changes: [] });
  });

  it("is not the whole change when a line is cut, altered or left out", () => {
    const long = heldChangePayload([{ op: "add", line: "x".repeat(600) }]);
    expect(long.rulesComplete).toBeUndefined();
    const hidden = heldChangePayload([{ op: "add", line: "Ship​ it" }]);
    expect(hidden.rulesComplete).toBeUndefined();
    const many = heldChangePayload(Array.from({ length: 41 }, (_, i) => ({ op: "add" as const, line: `Rule ${i}` })));
    expect(many.rulesComplete).toBeUndefined();
    expect(many.changes).toHaveLength(40);
    expect(heldChangePayload([]).rulesComplete).toBeUndefined();
  });
});
