/**
 * The morning digest lists each project's waiting tasks, read by PPM from its task store: on whom
 * and until when, the user's own first, capped with the rest counted. The card shows them under
 * the manager's items, on Telegram too (a title-only project gives only the count), and the ask to
 * the managers now asks them to say on whom and until when as well.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { digestWaiting } from "../../../../src/services/assistant-digest/digest-waiting-tasks.ts";
import { buildDigestCard } from "../../../../src/services/assistant-digest/digest-card-assembly.ts";
import { DIGEST_ASK_TEXT } from "../../../../src/services/assistant-digest/assistant-digest-env.ts";
import { formatManagerCard } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { digestWaitingSummary, type DigestProject } from "../../../../src/shared/assistant-digest.ts";
import type { AssistantCard } from "../../../../src/shared/assistant-cards.ts";
import type { TaskView } from "../../../../src/shared/ppm-tasks.ts";
import type { DigestRun } from "../../../../src/services/assistant-digest/digest-state.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 1);
let n = 0;
const task = (over: Partial<TaskView> = {}): TaskView => {
  n++;
  return {
    id: `t${n}`, projectKey: "k", number: n, title: `Task ${n}`, type: "task", statusId: "s", urgency: "week", importance: "should", rank: n,
    why: null, nextStep: null, notes: null, dueDate: null, tags: [], assigneeMemberId: null, waitingOnMemberId: null, waitingSince: null,
    parentId: null, workingSessionId: null, decision: null, fields: {}, links: [], result: null, handedOffAt: null, revision: 1,
    createdAt: 1, updatedAt: 1, closedAt: null, deletedAt: null, baseGroup: "waiting", closedAs: null, effectiveUrgency: "week",
    urgencyRaised: false, waitingStartedAt: null, ...over,
  };
};
const ctx = {
  ref: (t: TaskView) => `nxsys/${t.number}`, nameOf: (_t: TaskView, id: string) => (id === "m1" ? "Việt" : null),
  statusName: (t: TaskView) => (t.statusId === "blocked" ? "Blocked" : "Waiting"), today: "2026-11-17", now: NOW,
};

describe("digestWaiting", () => {
  it("words each waiting task, the user's own first, and leaves out tasks that do not wait", () => {
    const theirs = task({ waitingOnMemberId: "m1", waitingStartedAt: NOW - 2 * DAY });
    const nobody = task({ waitingStartedAt: NOW - 5 * 3_600_000 });
    const mine = task({ waitingOnMemberId: "me", dueDate: "2026-11-17" });
    const active = task({ baseGroup: "active" });
    const closed = task({ baseGroup: "closed", waitingOnMemberId: "me" });
    const out = digestWaiting([theirs, nobody, mine, active, closed], ctx);
    expect(out.waiting).toEqual([
      { ref: `nxsys/${mine.number}`, title: mine.title, label: "Waiting on you", mine: true, until: "Due today" },
      { ref: `nxsys/${theirs.number}`, title: theirs.title, label: "Waiting on Việt", mine: false, until: "for 2 days" },
      { ref: `nxsys/${nobody.number}`, title: nobody.title, label: "Waiting", mine: false, until: "for 5 hours" },
    ]);
    expect(out.waitingMine).toBe(1);
    expect(out.waitingMore).toBeUndefined();
  });

  it("says a Waiting-group status by its own name", () => {
    const out = digestWaiting([task({ statusId: "blocked", waitingOnMemberId: "m1" }), task({ statusId: "blocked" })], ctx);
    expect(out.waiting!.map((w) => w.label)).toEqual(["Blocked on Việt", "Blocked"]);
  });

  it("caps the list and counts the rest, the user's own counted even past the cap", () => {
    const tasks = [...Array.from({ length: 3 }, () => task({ waitingOnMemberId: "m1" })), ...Array.from({ length: 3 }, () => task({ waitingOnMemberId: "me" }))];
    const out = digestWaiting(tasks, ctx, 2);
    expect(out.waiting!.map((w) => w.mine)).toEqual([true, true]);
    expect(out.waitingMore).toBe(4);
    expect(digestWaitingSummary(out)).toBe("6 tasks waiting, 3 on you");
  });

  it("adds nothing when no task waits", () => {
    expect(digestWaiting([task({ baseGroup: "active" })], ctx)).toEqual({});
  });
});

describe("the digest card", () => {
  const run = (): DigestRun => ({
    date: "2026-11-17", startedAt: NOW, deadline: NOW + 3_600_000, asked: { k1: "m-a", k2: "m-b" }, names: { k1: "nxsys", k2: "pex" },
    delivered: {}, taken: {}, redelivered: {}, answers: { k1: ["Release 2.14 is out"] },
  } as DigestRun);
  const waitingOf = (key: string) => (key === "k1"
    ? { waiting: [{ ref: "nxsys/7", title: "Sign the <contract>", label: "Waiting on you", mine: true, until: "Due today" }, { ref: "nxsys/9", title: "Review", label: "Waiting on Việt", mine: false, until: "for 2 days" }], waitingMine: 1 }
    : {});

  it("puts each project's waiting tasks in its section, answered or not, and survives a store that cannot be read", () => {
    const card = buildDigestCard(run(), () => false, waitingOf);
    const projects = card.payload.projects as DigestProject[];
    expect(projects[0]).toMatchObject({ name: "nxsys", state: "answered", waitingMine: 1 });
    expect(projects[0]!.waiting).toHaveLength(2);
    expect(projects[1]).toMatchObject({ name: "pex", state: "no_answer" });
    expect(projects[1]!.waiting).toBeUndefined();
    const broken = buildDigestCard(run(), () => false, () => { throw new Error("db gone"); });
    expect((broken.payload.projects as DigestProject[])[0]!.items).toEqual(["Release 2.14 is out"]);
  });

  const telegram = (projects: DigestProject[]) => {
    const card = { id: "c", kind: "digest", projectName: null, projectKey: null, sessionId: null, title: "Morning digest", body: "", status: "open", answer: null,
      provenance: "Put together by PPM", createdAt: 1, updatedAt: 1, payload: { date: "2026-11-17", projects } } as unknown as AssistantCard;
    const parsed = parseTelegramHtml(formatManagerCard(card, "full").html);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.text;
  };

  it("shows them on Telegram with the user's own marked, and only the count for a title-only project", () => {
    const projects = buildDigestCard(run(), (key) => key === "k2", waitingOf).payload.projects as DigestProject[];
    const text = telegram(projects);
    expect(text).toContain("⏳ 2 tasks waiting, 1 on you:");
    expect(text).toContain("✋ nxsys/7 Sign the <contract> — Waiting on you · Due today");
    expect(text).toContain("• nxsys/9 Review — Waiting on Việt · for 2 days");
    const hidden = telegram([{ name: "tax", state: "answered", items: [], titleOnly: true, waiting: [{ ref: "tax/3", title: "Client 4471", label: "Waiting on you", mine: true, until: null }] }]);
    expect(hidden).toContain("1 task waiting, 1 on you; the details stay in PPM.");
    expect(hidden).not.toContain("4471");
  });

  it("keeps a full section on Telegram by giving up its waiting list, never the section", () => {
    const waiting = Array.from({ length: 8 }, (_, i) => ({ ref: `nxsys/${i}`, title: "t".repeat(80), label: "Waiting on Nguyễn Hoàng Minh Khôi", mine: false, until: "for 12 days" }));
    const text = telegram([{ name: "nxsys", state: "answered", items: Array(12).fill("x".repeat(200)), waiting, waitingMore: 4 }]);
    expect(text).toContain("12. ");
    expect(text).toContain("12 tasks waiting; the list is on the card in PPM.");
    expect(text).not.toContain("The rest is on the card in PPM.");
  });

  it("leaves the waits to PPM's own list: the managers are not asked to word them", () => {
    expect(DIGEST_ASK_TEXT).not.toContain("on whom");
  });
});
