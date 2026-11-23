/**
 * A manager's report about a card one of its chats already shows the user, against the real card
 * table: folded into that chat's mirror (named by `chat`, or by the one waiting chat whose id the
 * text names), never into a closed card, another project's, or the manager's own; and a report
 * carrying a draft, or naming no waiting chat, still filed as its own card.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import { findOpenChatMirrorCard, listCardRows } from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { CHAT_CARD_INFERRED_NOTE, CHAT_CARD_NOTE, fileReport, type ReportEnv } from "../../../src/services/assistant-cards/manager-report-tool.ts";
import { projectKey } from "../../../src/services/project-name-for-path.ts";

const now = 1_700_000_000_000;
const projects = [{ name: "api", path: "/p/api" }, { name: "web", path: "/p/web" }];
const cards = createAssistantCards({ now: () => now, projects: () => projects, announce: () => {} });
const caller = { sessionId: "11111111-1111-4111-8111-111111111111", projectName: "api", projectPath: "/p/api" };
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER_CHILD = "33333333-3333-4333-8333-333333333333";
const WEB_CHAT = "44444444-4444-4444-8444-444444444444";

// The server's `reportEnv` answers `waitingChatCard` the same way, through the global card store.
const env: ReportEnv = {
  now: () => now,
  countSince: () => 0,
  openUrgentTitled: () => null,
  openIdentical: () => null,
  waitingChatCard: (projectPath, chatSessionId) => {
    const row = findOpenChatMirrorCard([chatSessionId], projectKey(projectPath));
    return row ? cards.toCard(row) : null;
  },
  quietWindowStart: () => null,
  digestAnswer: () => ({ ok: false, message: "no" }),
  create: (card) => cards.create(card),
};

/** What `manager-signals.ts` files when a chat that is not a manager shows a card. */
function mirror(sessionId: string, project = projects[0]!, kind: "approval" | "question" = "approval") {
  return cards.create({
    kind, projectName: project.name, projectPath: project.path, sessionId,
    title: "Create schedule prod-issue-watch",
    payload: {
      requestId: `req-${sessionId.slice(0, 4)}-${kind}`,
      deciding: { kind: "session_collab", title: "Create schedule", facts: [], text: "prod-issue-watch", complete: true },
      chat: { title: "Watch prod", providerId: "claude" },
    } as never,
  });
}

const decisionCount = () => listCardRows({ limit: 50 }).filter((r) => r.kind === "needs_decision" || r.kind === "urgent").length;

beforeEach(() => { getDb().exec("DELETE FROM assistant_cards"); });

describe("a report about a card the user already has from the chat", () => {
  it("is folded into the chat's mirror when `chat` names it: the mirror's id back, nothing filed", () => {
    const shown = mirror(CHILD);
    const result = fileReport(env, caller, { kind: "needs_decision", title: "Child waits for your OK", body: "Allow the schedule?", chat: CHILD });
    expect(result).toEqual({ ok: true, cardId: shown.id, kind: "approval", note: CHAT_CARD_NOTE });
    expect(decisionCount()).toBe(0);
  });

  it("is folded in when the text names exactly one waiting chat's id, options and all", () => {
    const shown = mirror(CHILD, projects[0], "question");
    const result = fileReport(env, caller, {
      kind: "needs_decision", title: "A question waits", body: `Chat \`${CHILD.toUpperCase()}\` asks which branch to use.`,
      options: [{ id: "main", label: "Use main" }, { id: "dev", label: "Use dev" }],
    });
    expect(result).toMatchObject({ ok: true, cardId: shown.id, kind: "question" });
    // Told how to file it anyway, should it be about something else.
    expect(result.ok && result.note).toBe(`${CHAT_CARD_NOTE} ${CHAT_CARD_INFERRED_NOTE}`);
    expect(decisionCount()).toBe(0);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Watch prod: a different decision", body: "Merge its PR?" }))
      .toMatchObject({ kind: "needs_decision" });
    expect(decisionCount()).toBe(1);
  });

  it("is folded in from urgent too", () => {
    const shown = mirror(CHILD);
    expect(fileReport(env, caller, { kind: "urgent", title: "Card expires soon", chat: CHILD })).toMatchObject({ cardId: shown.id });
    expect(decisionCount()).toBe(0);
  });
});

describe("a report that stays its own card", () => {
  it("files when the named chat waits on nothing, or its card was answered", () => {
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Deploy?", chat: CHILD })).toMatchObject({ ok: true, kind: "needs_decision" });
    const shown = mirror(CHILD);
    cards.transition(shown.id, "resolved", { by: "user", channel: "ppm", approved: true, note: "Answered in the chat" } as never);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Deploy again?", chat: CHILD })).toMatchObject({ kind: "needs_decision" });
    expect(decisionCount()).toBe(2);
  });

  it("files a draft that names a waiting chat without `chat`: a message to send is its own decision", () => {
    mirror(CHILD);
    const result = fileReport(env, caller, {
      kind: "needs_decision", title: "Reply to Jim", body: `After chat ${CHILD} finishes.`, draft: { to: "Jim", text: "Done." },
    });
    expect(result).toMatchObject({ ok: true, kind: "needs_decision" });
    expect(decisionCount()).toBe(1);
  });

  it("files when the text names two waiting chats, since it cannot be about one card", () => {
    mirror(CHILD);
    mirror(OTHER_CHILD);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Two chats wait", body: `${CHILD} and ${OTHER_CHILD}` }))
      .toMatchObject({ kind: "needs_decision" });
  });

  it("never folds into another project's chat or the manager's own card", () => {
    mirror(WEB_CHAT, projects[1]);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Web waits", chat: WEB_CHAT })).toMatchObject({ kind: "needs_decision" });
    // The manager's own approval is mirrored without `payload.chat`.
    cards.create({ kind: "approval", projectName: "api", projectPath: "/p/api", sessionId: caller.sessionId, title: "Bash", payload: { requestId: "r-own" } as never });
    expect(fileReport(env, caller, { kind: "needs_decision", title: "Mine", chat: caller.sessionId })).toMatchObject({ kind: "needs_decision" });
    expect(decisionCount()).toBe(2);
  });

  it("refuses `chat` on done, failed and digest, and a `chat` that is not text", () => {
    expect(fileReport(env, caller, { kind: "done", title: "x", chat: CHILD }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "x", chat: 5 }).ok).toBe(false);
    expect(fileReport(env, caller, { kind: "needs_decision", title: "x", chat: " " }).ok).toBe(false);
  });
});
