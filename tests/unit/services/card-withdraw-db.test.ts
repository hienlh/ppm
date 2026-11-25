/**
 * Card withdrawal against the real card table: what a manager or the Assistant may take back
 * (whose cards, which kinds, which states, how many per turn), a report that replaces earlier
 * cards, the user's Restore, `report_withdraw` as a manager calls it, and cards about a task that
 * closes or opens again.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { createAssistantCards, type NewCard } from "../../../src/services/assistant-cards/assistant-cards.service.ts";
import {
  countWithdrawnBy, findOpenSessionCardsWithText, getCardRow, listOpenCardsForTasks, listOpenCardsWithIdPrefix, listOpenProjectCards,
} from "../../../src/services/assistant-cards/assistant-cards-db.ts";
import { ownsCard, withdrawCards, type WithdrawActor, type WithdrawEnv } from "../../../src/services/assistant-cards/card-withdraw.ts";
import { fileReport, sameReport, WITHDRAW_OFF_NOTE, type ReportEnv } from "../../../src/services/assistant-cards/manager-report-tool.ts";
import { reportWithdrawCall, type ReportWithdrawEnv } from "../../../src/services/assistant-cards/report-withdraw-tool.ts";
import { settleTaskCards, waitingCardsAboutClosedTask } from "../../../src/services/assistant-cards/card-task-closure.ts";
import { projectKey } from "../../../src/services/project-name-for-path.ts";
import { WITHDRAWABLE_CARD_KINDS, type AssistantCard } from "../../../src/shared/assistant-cards.ts";
import { WITHDRAW_PER_TURN } from "../../../src/shared/assistant-limits.ts";

let now = 1_700_000_000_000;
let turn: string | null = "turn-1";
const cards = createAssistantCards({ now: () => now, projects: () => [{ name: "api", path: "/p/api" }, { name: "web", path: "/p/web" }], announce: () => {} });
const KEY = projectKey("/p/api");
const manager: Extract<WithdrawActor, { kind: "manager" }> = { kind: "manager", sessionId: "mgr-1", projectKey: KEY };
const caller = { sessionId: "mgr-1", projectName: "api", projectPath: "/p/api" };

const env: WithdrawEnv = {
  cards,
  now: () => now,
  row: getCardRow,
  openWithPrefix: listOpenCardsWithIdPrefix,
  turnOf: () => turn,
  withdrawnCount: countWithdrawnBy,
};

function card(over: Partial<NewCard> = {}): AssistantCard {
  return cards.create({
    kind: "needs_decision", projectName: "api", projectPath: "/p/api", sessionId: "mgr-1", title: `Card ${now++}`, body: "", ...over,
  });
}

const reportEnv = (on = true): ReportEnv => ({
  now: () => now,
  countSince: () => 0,
  openUrgentTitled: () => null,
  openIdentical: (sessionId, c) => {
    for (const row of findOpenSessionCardsWithText(sessionId, c.kind, c.title, c.body ?? "")) {
      const open = cards.toCard(row);
      if (sameReport(open, c)) return open;
    }
    return null;
  },
  quietWindowStart: () => null,
  digestAnswer: () => ({ ok: false, message: "no" }),
  create: (c) => cards.create(c),
  withdrawOn: () => on,
  resolveTask: (_path, ref) => (ref === "#7" ? { taskId: "task-7", ref: "api/7", title: "Ship it" } : { error: `No task ${ref} in this project.` }),
  withdraw: (_c, refs, reason, by, dryRun) => withdrawCards(env, manager, refs, reason, by, dryRun),
  markSupersedes: (id, replaced) => { cards.patchPayload(id, { supersedes: replaced }, "changed"); },
  openOwnCards: (_c, except) => listOpenProjectCards(KEY, WITHDRAWABLE_CARD_KINDS)
    .filter((r) => r.id !== except && !r.answer && ownsCard(manager, r)).map((r) => cards.toCard(r)),
});

beforeEach(() => {
  getDb().exec("DELETE FROM assistant_cards");
  now += 60_000;
  turn = `turn-${now}`;
});

describe("withdrawing cards", () => {
  it("takes back a manager's own open report, saying why, and the card stops waiting", () => {
    const c = card();
    const [r] = withdrawCards(env, manager, [c.id], "Handled by the user");
    expect(r!.outcome).toBe("withdrawn");
    const after = cards.get(c.id)!;
    expect(after.status).toBe("dismissed");
    expect(after.answer).toMatchObject({ by: "manager", withdrawn: { sessionId: "mgr-1", reason: "Handled by the user", turnId: turn } });
    expect(cards.openCards().map((x) => x.id)).not.toContain(c.id);
  });

  it("takes a previous manager chat's card of the same project, never another project's or the Assistant's", () => {
    const older = card({ sessionId: "mgr-old" });
    const other = card({ projectName: "web", projectPath: "/p/web" });
    const assistants = card({ kind: "done", sessionId: null, projectName: "api", payload: { byAssistant: true } });
    const out = withdrawCards(env, manager, [older.id, other.id, assistants.id], "stale");
    expect(out.map((o) => o.outcome)).toEqual(["withdrawn", "not_yours", "not_yours"]);
  });

  it("never takes a chat's approval mirror, a rules change, a closed card or one whose answer did not arrive", () => {
    const mirror = card({ kind: "approval", payload: { requestId: "r1" } });
    const done = card();
    cards.transition(done.id, "answered", { by: "user", channel: "ppm", at: now });
    const reopened = card();
    cards.transition(reopened.id, "answered", { by: "user", channel: "ppm", at: now });
    cards.reopen(reopened.id, "Your answer was not sent");
    const out = withdrawCards(env, manager, [mirror.id, done.id, reopened.id], "stale");
    expect(out.map((o) => o.outcome)).toEqual(["kind", "not_open", "answer_pending"]);
    expect(cards.get(reopened.id)!.status).toBe("open");
  });

  it(`stops at ${WITHDRAW_PER_TURN} per turn, and a new turn may go on`, () => {
    const many = Array.from({ length: WITHDRAW_PER_TURN + 1 }, () => card());
    const first = withdrawCards(env, manager, many.slice(0, 5).map((c) => c.id), "stale");
    expect(first.every((o) => o.outcome === "withdrawn")).toBe(true);
    expect(withdrawCards(env, manager, [many[5]!.id], "stale")[0]!.outcome).toBe("limit");
    turn = "turn-next";
    expect(withdrawCards(env, manager, [many[5]!.id], "stale")[0]!.outcome).toBe("withdrawn");
  });

  it("counts by time when the turn is not known", () => {
    turn = null;
    const many = Array.from({ length: WITHDRAW_PER_TURN + 1 }, () => card());
    withdrawCards(env, manager, many.slice(0, 5).map((c) => c.id), "stale");
    expect(withdrawCards(env, manager, [many[5]!.id], "stale")[0]!.outcome).toBe("limit");
    now += 11 * 60_000;
    expect(withdrawCards(env, manager, [many[5]!.id], "stale")[0]!.outcome).toBe("withdrawn");
  });

  it("finds a card by its first eight characters, and refuses a prefix naming two", () => {
    const c = card();
    expect(withdrawCards(env, manager, [c.id.slice(0, 8)], "stale")[0]).toMatchObject({ outcome: "withdrawn", card: { id: c.id } });
    expect(withdrawCards(env, manager, ["zzzzzzzz"], "stale")[0]!.outcome).toBe("not_found");
    getDb().exec("DELETE FROM assistant_cards");
    const a = card();
    getDb().query("UPDATE assistant_cards SET id = ? WHERE id = ?").run(`${a.id.slice(0, 8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, a.id);
    const b = card();
    getDb().query("UPDATE assistant_cards SET id = ? WHERE id = ?").run(`${a.id.slice(0, 8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, b.id);
    expect(withdrawCards(env, manager, [a.id.slice(0, 8)], "stale")[0]!.outcome).toBe("ambiguous");
  });

  it("lets the Assistant take any report in a turn the user started, only its own otherwise", () => {
    const managers = card();
    const own = card({ kind: "done", sessionId: null, payload: { byAssistant: true } });
    const unattended = withdrawCards(env, { kind: "assistant", sessionId: "asst", userTurn: false }, [managers.id, own.id], "cleared");
    expect(unattended.map((o) => o.outcome)).toEqual(["not_yours", "withdrawn"]);
    expect(withdrawCards(env, { kind: "assistant", sessionId: "asst", userTurn: true }, [managers.id], "cleared")[0]!.outcome).toBe("withdrawn");
    expect(cards.get(managers.id)!.answer?.by).toBe("assistant");
  });
});

describe("Restore", () => {
  it("brings back a withdrawn card once, and never a card the user dismissed", () => {
    const c = card();
    withdrawCards(env, manager, [c.id], "stale");
    const back = cards.restore(c.id);
    expect(back.ok).toBe(true);
    expect(cards.get(c.id)!.status).toBe("open");
    expect(cards.get(c.id)!.answer).toBeNull();
    expect(cards.restore(c.id).ok).toBe(false);
    const mine = card();
    cards.transition(mine.id, "dismissed", { by: "user", channel: "ppm", at: now });
    expect(cards.restore(mine.id).ok).toBe(false);
  });

  it("tells its listeners the card was restored", () => {
    const seen: string[] = [];
    const off = cards.onChange((_c, change) => seen.push(change));
    const c = card();
    withdrawCards(env, manager, [c.id], "stale");
    cards.restore(c.id);
    off();
    expect(seen).toEqual(["created", "changed", "restored"]);
  });
});

describe("a report that replaces earlier cards", () => {
  it("files the new card, withdraws the old ones naming it, and lists the manager's other open cards", () => {
    const old = card({ title: "Pay the photographer?" });
    const unrelated = card({ title: "Review PR 12" });
    const r = fileReport(reportEnv(), caller, { kind: "needs_decision", title: "Pay the photographer today?", supersedes: [old.id] });
    if (!r.ok) throw new Error(r.message);
    const was = cards.get(old.id)!;
    expect(was.status).toBe("dismissed");
    expect(was.answer?.withdrawn?.supersededBy).toEqual({ id: r.cardId!, title: "Pay the photographer today?" });
    expect(r.withdrawn?.map((w) => w.outcome)).toEqual(["withdrawn"]);
    // Made knowing what it replaces, so Telegram and PPM say so from the start.
    expect(cards.get(r.cardId!)!.payload.supersedes).toEqual([{ id: old.id, title: "Pay the photographer?" }]);
    expect(r.note).toContain(unrelated.id);
    expect(r.note).not.toContain(old.id.concat(" [needs"));
  });

  it("records the task a card is about, and refuses one that is not this project's", () => {
    const r = fileReport(reportEnv(), caller, { kind: "done", title: "Shipped", task: "#7" });
    if (!r.ok) throw new Error(r.message);
    expect(cards.get(r.cardId!)!.payload.aboutTask).toEqual({ taskId: "task-7", ref: "api/7", title: "Ship it" });
    const bad = fileReport(reportEnv(), caller, { kind: "done", title: "Shipped", task: "#8" });
    expect(bad).toEqual({ ok: false, message: "No task #8 in this project." });
  });

  it("refuses `supersedes` and `task` while the user has card withdrawal off, and lists nothing", () => {
    const old = card();
    expect(fileReport(reportEnv(false), caller, { kind: "needs_decision", title: "New", supersedes: [old.id] }))
      .toEqual({ ok: false, message: WITHDRAW_OFF_NOTE });
    const r = fileReport(reportEnv(false), caller, { kind: "needs_decision", title: "New" });
    if (!r.ok) throw new Error(r.message);
    expect(r.note).toBeUndefined();
    expect(cards.get(old.id)!.status).toBe("open");
  });

  it("refuses a bad `supersedes` before filing anything", () => {
    const r = fileReport(reportEnv(), caller, { kind: "digest", title: "x", items: [], supersedes: ["a"] });
    expect(r.ok).toBe(false);
    expect(fileReport(reportEnv(), caller, { kind: "done", title: "x", supersedes: [] }).ok).toBe(false);
    expect((getDb().query("SELECT COUNT(*) AS n FROM assistant_cards").get() as { n: number }).n).toBe(0);
  });
});

describe("report_withdraw", () => {
  const toolEnv: ReportWithdrawEnv = {
    manager: (id) => (id === "mgr-1" ? { sessionId: "mgr-1", projectKey: KEY } : null),
    withdraw: env,
    openCards: (actor) => listOpenProjectCards(actor.projectKey, WITHDRAWABLE_CARD_KINDS).filter((r) => !r.answer && ownsCard(actor, r)).map((r) => cards.toCard(r)),
  };
  const answer = (out: unknown) => JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text);

  it("lists the manager's open cards when called with no cards", () => {
    const c = card();
    const out = answer(reportWithdrawCall("mgr-1", {}, toolEnv));
    expect(out.listed.map((l: { id: string }) => l.id)).toEqual([c.id]);
  });

  it("withdraws with a reason, names the card that replaces them, and refuses another chat", () => {
    const old = card();
    const next = card();
    const out = answer(reportWithdrawCall("mgr-1", { cards: [old.id], reason: "Asked again", superseded_by: next.id }, toolEnv));
    expect(out.withdrawn).toEqual([{ card: old.id, title: old.title, outcome: "withdrawn" }]);
    expect(cards.get(old.id)!.answer?.withdrawn?.supersededBy?.id).toBe(next.id);
    expect((reportWithdrawCall("someone", { cards: [next.id], reason: "x" }, toolEnv) as { isError?: boolean }).isError).toBe(true);
    expect((reportWithdrawCall("mgr-1", { cards: [next.id] }, toolEnv) as { isError?: boolean }).isError).toBe(true);
  });
});

describe("cards about a task", () => {
  let closed = true;
  const deps = {
    cards, now: () => now, on: () => true,
    task: (id: string) => (id === "task-7" ? { closed, closedAs: closed ? "done" as const : null } : null),
    openCards: listOpenCardsForTasks,
  };
  const about = { aboutTask: { taskId: "task-7", ref: "api/7" } };

  it("clears a done card, marks a waiting one, and takes the mark away when the task opens again", () => {
    closed = true;
    const news = card({ kind: "done", payload: about });
    const ask = card({ kind: "needs_decision", payload: about });
    expect(settleTaskCards(["task-7"], deps)).toBe(2);
    expect(cards.get(news.id)!.status).toBe("dismissed");
    expect(cards.get(news.id)!.answer?.note).toBe("Task api/7 was closed");
    expect(cards.get(ask.id)!.status).toBe("open");
    expect(cards.get(ask.id)!.payload.taskClosed).toMatchObject({ closedAs: "done" });
    expect(waitingCardsAboutClosedTask("task-7", "report_withdraw", deps)).toContain(ask.id);
    closed = false;
    settleTaskCards(["task-7"], deps);
    expect(cards.get(ask.id)!.payload.taskClosed).toBeUndefined();
  });

  it("does nothing while card withdrawal is off", () => {
    closed = true;
    const news = card({ kind: "done", payload: about });
    expect(settleTaskCards(["task-7"], { ...deps, on: () => false })).toBe(0);
    expect(cards.get(news.id)!.status).toBe("open");
    expect(waitingCardsAboutClosedTask("task-7", "report_withdraw", { ...deps, on: () => false })).toBeNull();
  });
});
