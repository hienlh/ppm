/**
 * Telegram `/tasks`: a waiting task's card says on whom it waits and until when, the user's own
 * wait marked and bold; its due date moves onto that line rather than showing twice; a title-only
 * project keeps it off the phone.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { deckCardHtml, type TaskCardFacts } from "../../../../src/services/assistant-telegram/assistant-telegram-task-card.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

const NOW = Date.UTC(2026, 10, 16, 7);
const CTX = { detail: "full" as const, today: "2026-11-16", now: NOW };
const POS = { index: 2, total: 9 };
const facts = (over: Partial<TaskCardFacts> = {}): TaskCardFacts => ({
  ref: "nxsys/7", projectName: "nxsys", title: "Payslip wording", type: "task", statusName: "Waiting", closed: false,
  urgency: "today", urgencyRaised: false, importance: "should", dueDate: null, assignee: null, waiting: null,
  nextStep: null, linkLines: [], ...over,
});
function shown(html: string): string {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(`Telegram would refuse: ${parsed.error}\n${html}`);
  return parsed.text;
}

describe("the waiting line on a /tasks card", () => {
  it("marks a wait on the user and gives its due date there instead of on its own line", () => {
    const html = deckCardHtml(facts({ dueDate: "2026-11-17", waiting: { label: "Waiting on you", name: "you", mine: true, until: { kind: "due", dueDate: "2026-11-17" } } }), POS, CTX);
    expect(html).toContain("✋ <b>Waiting on you</b> · Due tomorrow");
    expect(shown(html).split("\n")).toEqual([
      "3 of 9 · What to do first",
      "nxsys/7 Payslip wording",
      "nxsys · Today · Should · Waiting",
      "✋ Waiting on you · Due tomorrow",
    ]);
  });

  it("names someone else and how long it has waited when there is no date", () => {
    const html = deckCardHtml(facts({ waiting: { label: "Waiting on Việt", name: "Việt", mine: false, until: { kind: "for", since: NOW - 2 * 86_400_000 } } }), POS, CTX);
    expect(shown(html)).toContain("⏳ Waiting on Việt · for 2 days");
    expect(html).not.toContain("<b>Waiting on");
  });

  it("says Waiting with how long when nobody is named, and only Waiting when nothing is known", () => {
    expect(shown(deckCardHtml(facts({ waiting: { label: "Waiting", name: null, mine: false, until: { kind: "for", since: NOW - 5 * 3_600_000 } } }), POS, CTX)))
      .toContain("⏳ Waiting · for 5 hours");
    expect(shown(deckCardHtml(facts({ waiting: { label: "Waiting", name: null, mine: false, until: null } }), POS, CTX)).split("\n").at(-1)).toBe("⏳ Waiting");
  });

  it("says the label it is given, so a Blocked status reads Blocked, not Waiting", () => {
    const html = deckCardHtml(facts({ statusName: "Blocked", waiting: { label: "Blocked on Việt", name: "Việt", mine: false, until: null } }), POS, CTX);
    expect(shown(html).split("\n").at(-1)).toBe("⏳ Blocked on Việt");
  });

  it("escapes a member's name before it is formatted", () => {
    const html = deckCardHtml(facts({ waiting: { label: "Waiting on <Ops & co>", name: "<Ops & co>", mine: false, until: null } }), POS, CTX);
    expect(shown(html)).toContain("⏳ Waiting on <Ops & co>");
  });

  it("keeps the wait off the phone for a title-only project", () => {
    const html = deckCardHtml(facts({ waiting: { label: "Waiting on you", name: "you", mine: true, until: null } }), POS, { ...CTX, detail: "title" });
    expect(shown(html)).not.toContain("Waiting on");
  });
});
