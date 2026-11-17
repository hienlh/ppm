/**
 * The task cards PPM sends to Telegram: escaped before formatted (Telegram refuses the whole
 * message on one stray `<` or `&`), secrets redacted, a title-only project's details kept off the
 * phone, never over one message, and the status buttons a project offers.
 */
import { describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import {
  childrenHtml, createdCardHtml, deckCardHtml, dueText, statusChoices, statusResultHtml, type TaskCardFacts,
} from "../../../../src/services/assistant-telegram/assistant-telegram-task-card.ts";
import { telegramVisibleLength, TELEGRAM_CARD_ROOM } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

const facts = (over: Partial<TaskCardFacts> = {}): TaskCardFacts => ({
  ref: "nxsys/12", projectName: "nxsys", title: "PSR Ireland bỏ sót payslip", type: "task", statusName: "In progress", closed: false,
  urgency: "now", urgencyRaised: false, importance: "must", dueDate: "2026-11-17", assignee: "Minh Anh", waiting: null,
  nextStep: "fix period-13 filter, get #2231 green.", linkLines: ["NX-6318 In Progress", "PR #2231 open · CI failing"], ...over,
});
const CTX = { detail: "full" as const, today: "2026-11-16", now: Date.UTC(2026, 10, 16, 7) };
const TITLE_ONLY = { ...CTX, detail: "title" as const };
const POS = { index: 0, total: 14 };

/** Telegram's own parse: throws on HTML it would refuse, returns what the phone shows. */
function shown(html: string): string {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(`Telegram would refuse: ${parsed.error}\n${html}`);
  return parsed.text;
}

describe("deck card", () => {
  it("reads like the design: position, title, the facts, links and the next step", () => {
    expect(shown(deckCardHtml(facts(), POS, CTX)).split("\n")).toEqual([
      "1 of 14 · What to do first",
      "nxsys/12 PSR Ireland bỏ sót payslip",
      "nxsys · Now · Must · In progress",
      "Due tomorrow · Minh Anh",
      "NX-6318 In Progress",
      "PR #2231 open · CI failing",
      "Next: fix period-13 filter, get #2231 green.",
    ]);
  });

  it("sets the task's code in monospace before the title, so a tap on the phone copies it", () => {
    expect(deckCardHtml(facts(), POS, CTX)).toContain("<code>nxsys/12</code> <b>PSR Ireland bỏ sót payslip</b>");
    expect(deckCardHtml(facts({ ref: "a&b/3" }), POS, CTX)).toContain("<code>a&amp;b/3</code>");
  });

  it("escapes every text a person or an AI wrote before formatting it", () => {
    const html = deckCardHtml(facts({ title: "a < b && <script>x</script>", projectName: "p&q", assignee: "<i>me</i>", nextStep: "use </b> here" }), POS, CTX);
    const text = shown(html);
    expect(text).toContain("a < b && <script>x</script>");
    expect(text).toContain("p&q");
    expect(text).toContain("<i>me</i>");
    expect(text).toContain("use </b> here");
  });

  it("redacts a secret-looking value and says so", () => {
    const text = shown(deckCardHtml(facts({ nextStep: "rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 today" }), POS, CTX));
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text).toContain("secret-looking value hidden");
  });

  it("shows only the title, project and urgency for a title-only project", () => {
    const text = shown(deckCardHtml(facts(), POS, TITLE_ONLY));
    expect(text.split("\n")).toEqual(["1 of 14 · What to do first", "nxsys/12 PSR Ireland bỏ sót payslip", "nxsys · Now"]);
    for (const hidden of ["Must", "In progress", "Minh Anh", "NX-6318", "PR #2231", "Next:"]) expect(text).not.toContain(hidden);
  });

  it("never outgrows one Telegram message", () => {
    const long = "x".repeat(5000);
    const html = deckCardHtml(facts({ title: long, nextStep: long, linkLines: [long, long, long, long], assignee: long }), POS, CTX);
    expect(telegramVisibleLength(html)).toBeLessThanOrEqual(TELEGRAM_CARD_ROOM);
    shown(html);
  });

  it("makes a link line open the issue or the PR, escaping the address", () => {
    const html = deckCardHtml(facts({ linkLines: [
      { text: "AL-6284 Dev Failed", href: "https://alpha.atlassian.net/browse/AL-6284" },
      { text: "PR #2424 open", href: "https://github.com/alpha/beta-web/pull/2424?a=1&b=<2>" },
      { text: "AL-7", href: null },
    ] }), POS, CTX);
    expect(html).toContain('<a href="https://alpha.atlassian.net/browse/AL-6284">AL-6284 Dev Failed</a>');
    expect(html).toContain('<a href="https://github.com/alpha/beta-web/pull/2424?a=1&amp;b=%3C2%3E">PR #2424 open</a>');
    expect(shown(html).split("\n")).toContain("AL-7");
  });

  it("never makes a non-web or private address tapable", () => {
    const html = deckCardHtml(facts({ linkLines: [
      { text: "AL-1", href: "javascript:alert(1)" }, { text: "AL-2", href: "data:text/html,x" },
      { text: "AL-3", href: "http://jira.alpha.example/browse/AL-3" }, { text: "AL-4", href: "https://jira:8080/browse/AL-4" },
      { text: "AL-5", href: "https://10.0.0.5/browse/AL-5" },
    ] }), POS, CTX);
    expect(html).not.toContain("<a ");
    expect(shown(html)).toContain("AL-1");
  });

  it("keeps a title-only project's links, tapable or not, off the phone", () => {
    const text = shown(deckCardHtml(facts({ linkLines: [{ text: "AL-6284 Dev Failed", href: "https://alpha.atlassian.net/browse/AL-6284" }] }), POS, TITLE_ONLY));
    expect(text).not.toContain("AL-6284");
    expect(deckCardHtml(facts({ linkLines: [{ text: "AL-6284", href: "https://alpha.atlassian.net/browse/AL-6284" }] }), POS, TITLE_ONLY)).not.toContain("<a ");
  });

  it("puts PPM's note above the card", () => {
    expect(shown(deckCardHtml(facts(), POS, CTX, "Changed elsewhere — here is the current state.")).split("\n")[0]).toBe("⚠️ Changed elsewhere — here is the current state.");
  });
});

describe("due dates", () => {
  it("words a due date against the user's today", () => {
    expect(dueText("2026-11-14", "2026-11-16")).toBe("Overdue (2026-11-14)");
    expect(dueText("2026-11-16", "2026-11-16")).toBe("Due today");
    expect(dueText("2026-11-17", "2026-11-16")).toBe("Due tomorrow");
    expect(dueText("2026-11-20", "2026-11-16")).toBe("Due in 4 days");
    expect(dueText("2026-12-20", "2026-11-16")).toBe("Due 2026-12-20");
  });
});

describe("status change", () => {
  it("strikes a closed task through and says what changed, by whom", () => {
    const html = statusResultHtml(facts({ closed: true }), POS, { from: "In progress", to: "Done", at: "14:02", openChildren: 2 });
    expect(html).toContain("<s>PSR Ireland bỏ sót payslip</s>");
    expect(shown(html).split("\n")).toEqual([
      "1 of 14 · What to do first",
      "nxsys/12 PSR Ireland bỏ sót payslip",
      "Status: In progress → Done",
      "By you from Telegram, 14:02. 2 child tasks are still open.",
    ]);
  });

  it("adds what became of the manager once the user answered", () => {
    const text = shown(statusResultHtml(facts(), POS, { from: "To do", to: "Waiting", at: "09:00", openChildren: 0, managerLine: "Sent to the <nxsys> manager." }));
    expect(text.split("\n").at(-1)).toBe("Sent to the <nxsys> manager.");
  });
});

describe("children", () => {
  it("lists open children and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ref: `nxsys/${i + 20}`, title: `Child ${i}`, statusName: "To do" }));
    const html = childrenHtml({ ref: "nxsys/19", title: "Parent & co" }, many);
    const text = shown(html);
    expect(text).toContain("Open child tasks of nxsys/19 Parent & co");
    expect(html).toContain("<code>nxsys/20</code> Child 0");
    expect(text).toContain("• nxsys/20 Child 0 — To do");
    expect(text).toContain("…and 2 more in PPM.");
  });
});

describe("created card", () => {
  it("reads like the design", () => {
    const f = facts({ ref: "ppm/88", projectName: "ppm", title: "Viết lại hướng dẫn cài đặt cho bản mới", urgency: "week", importance: "should", statusName: "Backlog", dueDate: null, assignee: null, linkLines: [], nextStep: null });
    expect(shown(createdCardHtml(f, CTX, { managerLine: "The ppm manager chat was told." })).split("\n")).toEqual([
      "Created in ppm",
      "ppm/88 Viết lại hướng dẫn cài đặt cho bản mới",
      "Task · This week · Should · Backlog",
      "The ppm manager chat was told.",
    ]);
  });

  it("keeps a title-only project's details off the phone", () => {
    const text = shown(createdCardHtml(facts(), TITLE_ONLY, { managerLine: null }));
    expect(text.split("\n")).toEqual(["Created in nxsys", "nxsys/12 PSR Ireland bỏ sót payslip", "nxsys · Now"]);
  });

  it("says the creation was undone", () => {
    const html = createdCardHtml(facts(), CTX, { managerLine: null, undone: true });
    expect(html).toContain("<s>");
    expect(shown(html)).toContain("Undone: the task was removed.");
  });
});

describe("status buttons", () => {
  const s = (id: string, baseGroup: string, closedAs: string | null = null) => ({ id, name: id, baseGroup, closedAs });
  const project = [
    s("todo", "not_started"), s("doing", "active"), s("review", "active"), s("waiting", "waiting"),
    s("staging", "waiting"), s("done", "closed", "done"), s("dropped", "closed", "dropped"), s("later", "not_started"),
  ];

  it("offers the project's own statuses except the current one, done last, at most six", () => {
    const ids = statusChoices(project, "doing").map((c) => c.id);
    expect(ids).toEqual(["todo", "review", "waiting", "staging", "dropped", "done"]);
    expect(ids).not.toContain("doing");
  });

  it("never offers the status the task is in", () => {
    expect(statusChoices(project, "done").map((c) => c.id)).not.toContain("done");
  });
});
