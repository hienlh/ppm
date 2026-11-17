/**
 * Where a snooze shows outside the task list: Telegram `/tasks` leaves snoozed tasks out of the
 * deck (also one snoozed after the deck was made) and says how many it left out; the morning
 * digest carries PPM's own "Back from snooze today" section, on the card and on Telegram.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { createTask, updateTask } from "../../../../src/services/ppm-tasks/ppm-tasks.service.ts";
import { todayYmd } from "../../../../src/services/ppm-tasks/ppm-tasks-today.ts";
import { deckSnoozedCount, deckTaskIds, type Deck } from "../../../../src/services/assistant-telegram/assistant-telegram-tasks-deck.ts";
import { cardAt } from "../../../../src/services/assistant-telegram/assistant-telegram-tasks-deck-draw.ts";
import { deckCardHtml, deckEmptyHtml, snoozedLine } from "../../../../src/services/assistant-telegram/assistant-telegram-task-card.ts";
import { formatManagerCard } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { buildDigestCard } from "../../../../src/services/assistant-digest/digest-card-assembly.ts";
import type { DigestRun } from "../../../../src/services/assistant-digest/digest-state.ts";
import { addDaysYmd } from "../../../../src/shared/ppm-tasks.ts";
import { freshProject, USER, type Fixture } from "./ppm-tasks-fixture.ts";

let f: Fixture;
beforeEach(() => { f = freshProject(); });

const deckOf = (taskIds: string[]): Deck => ({
  id: "d", chatId: "c", messageId: null, projectKey: null, taskIds, index: 0, view: { kind: "empty", finished: false },
  undo: null, asked: new Set(), cancelAdvance: null, seq: 0,
});

describe("Telegram /tasks", () => {
  it("leaves snoozed tasks out of the deck and counts them", () => {
    const open = createTask({ projectKey: f.projectKey, title: "Open", urgency: "now" }, USER);
    const hidden = createTask({ projectKey: f.projectKey, title: "Hidden", urgency: "now", importance: "must" }, USER);
    updateTask(hidden.id, { snoozedUntil: addDaysYmd(todayYmd(), 2) }, hidden.revision, USER);
    expect(deckTaskIds(null)).toEqual([open.id]);
    expect(deckSnoozedCount(null)).toBe(1);
    expect(deckSnoozedCount(f.projectKey)).toBe(1);
  });

  it("skips a task snoozed after the deck was made", () => {
    const a = createTask({ projectKey: f.projectKey, title: "A", urgency: "now", importance: "must" }, USER);
    const b = createTask({ projectKey: f.projectKey, title: "B", urgency: "now" }, USER);
    const deck = deckOf(deckTaskIds(null));
    updateTask(a.id, { snoozedUntil: addDaysYmd(todayYmd(), 1) }, a.revision, USER);
    expect(cardAt(deck)).toMatchObject({ kind: "card", taskId: b.id });
    expect(deck.taskIds).toEqual([b.id]);
  });

  it("says how many are snoozed under a card and on the empty view, and nothing when none are", () => {
    expect(snoozedLine(0)).toEqual([]);
    expect(snoozedLine(3)[0]).toContain("3 snoozed");
    expect(deckEmptyHtml(null, false, 2)).toContain("2 snoozed");
    expect(deckEmptyHtml(null, false, 0)).toBe("No open tasks.");
    const facts = {
      ref: "demo/1", projectName: "demo", title: "T", type: "task", statusName: "To do", closed: false, urgency: "now" as const,
      urgencyRaised: false, importance: "must" as const, dueDate: null, assignee: null, waitingOn: null, waitingSince: null, nextStep: null, linkLines: [],
    };
    const html = deckCardHtml(facts, { index: 0, total: 1 }, { detail: "full", today: "2026-11-17", now: Date.now() }, undefined, 1);
    expect(html).toContain("1 snoozed");
  });
});

describe("the morning digest", () => {
  const run: DigestRun = {
    date: "2026-11-18", startedAt: 1, deadline: 2, asked: { k: "s" }, names: { k: "demo" }, delivered: {}, taken: {}, redelivered: {},
    answers: { k: ["PR merged"] },
  };
  const back = [{ project: "demo", ref: "demo/4", title: "Merge to staging" }];

  it("puts the tasks back from snooze on the card, apart from the managers' items", () => {
    const card = buildDigestCard(run, () => false, back);
    expect(card.payload.resurfaced).toEqual(back);
    expect(card.payload.projects).toEqual([{ name: "demo", state: "answered", items: ["PR merged"] }]);
    expect(buildDigestCard(run, () => false).payload.resurfaced).toBeUndefined();
  });

  it("lists them first on Telegram", () => {
    const card = buildDigestCard(run, () => false, back);
    const out = formatManagerCard({ ...card, provenance: null, body: null, okOffered: false } as never, "full");
    expect(out.html).toContain("Back from snooze today");
    expect(out.html).toContain("demo/4");
    expect(out.html.indexOf("Back from snooze today")).toBeLessThan(out.html.indexOf("PR merged"));
  });
});
