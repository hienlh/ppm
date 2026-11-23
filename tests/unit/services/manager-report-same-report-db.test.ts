/**
 * The same report filed twice, against the real card table: the open card found by its stored title,
 * body and payload (which PPM extends with the project name, and which goes through JSON), a closed
 * card never matched, and no hourly limit however many reports a manager files.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { findOpenSessionCardsWithText } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { fileReport, SAME_REPORT_NOTE, sameReport, type ReportEnv } from "../../../src/services/assistant-cards/manager-report-tool.ts";

let now = 1_700_000_000_000;
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "api", path: "/p/api" }], announce: () => {} });
const caller = { sessionId: "mgr-1", projectName: "api", projectPath: "/p/api" };

// The server's `reportEnv` answers `openIdentical` the same way, through the global card store.
const env: ReportEnv = {
  now: () => now,
  countSince: () => 0,
  openUrgentTitled: () => null,
  openIdentical: (sessionId, card) => {
    for (const row of findOpenSessionCardsWithText(sessionId, card.kind, card.title, card.body ?? "")) {
      const open = cards.toCard(row);
      if (sameReport(open, card)) return open;
    }
    return null;
  },
  quietWindowStart: () => null,
  digestAnswer: () => ({ ok: false, message: "no" }),
  create: (card) => cards.create(card),
};

const decision = {
  kind: "needs_decision", title: "Deploy to staging?", body: "Build is **green**.",
  options: [{ id: "deploy", label: "Deploy now", description: "Ships build 41." }, { id: "wait", label: "Wait" }],
};

beforeEach(() => {
  getDb().exec("DELETE FROM assistant_cards");
  now += 1000;
});

describe("the same report against the card table", () => {
  it("hands back the stored open card, and files nothing new", () => {
    const first = fileReport(env, caller, decision);
    const again = fileReport(env, caller, decision);
    if (!first.ok || !again.ok) throw new Error("refused");
    expect(again.cardId).toBe(first.cardId);
    expect(again.note).toBe(SAME_REPORT_NOTE);
    expect((getDb().query("SELECT COUNT(*) AS n FROM assistant_cards").get() as { n: number }).n).toBe(1);
  });

  it("files a new card once the earlier one is dismissed", () => {
    const first = fileReport(env, caller, decision);
    if (!first.ok) throw new Error("refused");
    expect(cards.transition(first.cardId!, "dismissed", null).ok).toBe(true);
    const again = fileReport(env, caller, decision);
    if (!again.ok) throw new Error("refused");
    expect(again.cardId).not.toBe(first.cardId);
    expect(again.note).toBeUndefined();
  });

  it("files 25 different decisions in a row, each its own card", () => {
    for (let i = 0; i < 25; i++) expect(fileReport(env, caller, { ...decision, title: `Deploy build ${i}?` }).ok).toBe(true);
    expect((getDb().query("SELECT COUNT(*) AS n FROM assistant_cards").get() as { n: number }).n).toBe(25);
  });
});
