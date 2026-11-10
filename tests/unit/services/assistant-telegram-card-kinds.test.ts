/**
 * What the Assistant's cards say on Telegram: the title detail level keeps the body and the draft
 * off the phone and offers nothing that acts on them; "OK, send" only where the whole decision is
 * shown; "Approve change" only where the whole diff is; everything parses as Telegram HTML.
 */
import { describe, expect, it } from "bun:test";
import { formatManagerCard, cardEndLine } from "../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { cardOkOffered } from "../../../src/services/assistant-cards/card-ok-rule.ts";
import { parseTelegramHtml } from "../../helpers/fake-telegram-bot-api.ts";
import type { AssistantCard } from "../../../src/shared/assistant-cards.ts";

function card(over: Partial<AssistantCard>): AssistantCard {
  const base: AssistantCard = {
    id: "3f1c2a9e-5b7d-4e21-9a0c-7d1e2f3a4b5c", kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr",
    title: "Slack draft to Top", body: "Pension <wrong> in period 32 & 33.", status: "open", answer: null,
    provenance: "Written by the nxsys manager AI", createdAt: 1, updatedAt: 1,
    payload: { draft: { to: "#culi-devs", text: "Fix is in PR #1301 — staging this afternoon.", sha256: "a".repeat(64) } },
    ...over,
  };
  return cardOkOffered(base) ? { ...base, okOffered: true } : base;
}
const visible = (html: string) => {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.text;
};

describe("a needs-decision card on Telegram", () => {
  it("shows the label, provenance, body and quoted draft, with OK, send and the reply hint", () => {
    const f = formatManagerCard(card({}), "full");
    const text = visible(f.html);
    expect(text).toContain("Needs your decision · nxsys");
    expect(text).toContain("Written by the nxsys manager AI");
    expect(text).toContain("Pension <wrong> in period 32 & 33.");
    expect(text).toContain("Fix is in PR #1301");
    expect(text).toContain("Reply to this message to answer in your own words.");
    expect(f.buttons).toEqual([{ text: "OK, send", op: "ok" }]);
  });

  it("offers no OK for a 4000-character draft, and shows only a preview of it", () => {
    const f = formatManagerCard(card({ payload: { draft: { to: "x", text: "y".repeat(4000), sha256: "a".repeat(64) } } }), "full");
    expect(f.buttons).toEqual([]);
    expect(visible(f.html)).toContain("Too long to review here");
    expect(visible(f.html).length).toBeLessThan(4096);
  });

  it("at the title level shows no body or draft, and no OK", () => {
    const f = formatManagerCard(card({}), "title");
    const text = visible(f.html);
    expect(text).toContain("Slack draft to Top");
    expect(text).not.toContain("Pension");
    expect(text).not.toContain("PR #1301");
    expect(f.buttons).toEqual([]);
  });

  it("says OK, not OK, send, when there is no draft", () => {
    expect(formatManagerCard(card({ payload: {} }), "full").buttons).toEqual([{ text: "OK", op: "ok" }]);
  });
});

describe("a rules change on Telegram", () => {
  const rules = (added: string[]) => card({
    kind: "rules_change", provenance: null, body: "", title: "Rules change waiting",
    payload: { added, removed: ["Never push to main."], rulesHash: "f".repeat(64) },
  });

  it("offers Approve change only when the whole diff fits; Revert always", () => {
    expect(formatManagerCard(rules(["Push to main when green."]), "full").buttons.map((b) => b.op)).toEqual(["approve", "revert"]);
    expect(formatManagerCard(rules(["x".repeat(4000)]), "full").buttons.map((b) => b.op)).toEqual(["revert"]);
    expect(formatManagerCard(rules(["Push to main when green."]), "title").buttons.map((b) => b.op)).toEqual(["revert"]);
  });

  it("offers no Approve when part of the diff was hidden as a secret", () => {
    const f = formatManagerCard(rules(["Use key AKIAABCDEFGHIJKLMNOP for uploads."]), "full");
    expect(f.buttons.map((b) => b.op)).toEqual(["revert"]);
    expect(visible(f.html)).toContain("1 secret-looking value hidden");
  });
});

describe("the morning digest on Telegram", () => {
  const digest = (projects: NonNullable<AssistantCard["payload"]["projects"]>) => card({
    kind: "digest", projectName: null, projectKey: null, sessionId: null, body: "", title: "Morning digest · 3 projects, 2 items",
    provenance: "Put together by PPM; each item was written by that project's manager AI", payload: { date: "2026-11-10", projects },
  });

  it("lists each project's items, says who did not answer, and keeps a title-only project's items off the phone", () => {
    const f = formatManagerCard(digest([
      { name: "nxsys", state: "answered", items: ["OK the Slack draft <now>", "Release 2.14"] },
      { name: "pex", state: "no_answer", items: [] },
      { name: "tax", state: "answered", items: ["Client 4471 payslip wrong"], titleOnly: true },
    ]), "full");
    const text = visible(f.html);
    expect(text).toContain("Morning digest");
    expect(text).toContain("1. OK the Slack draft <now>");
    expect(text).toContain("2. Release 2.14");
    expect(text).toContain("No answer yet (busy)");
    expect(text).toContain("1 item; the details stay in PPM for this project.");
    expect(text).not.toContain("4471");
    expect(f.buttons).toEqual([]);
  });

  it("stays under Telegram's limit however many projects answered", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, state: "answered" as const, items: Array(12).fill("x".repeat(200)) }));
    const text = visible(formatManagerCard(digest(many), "full").html);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain("The rest is on the card in PPM.");
  });
});

describe("the end of a card", () => {
  it("says how it ended", () => {
    expect(visible(cardEndLine(card({ status: "answered", answer: { by: "user", channel: "ppm", at: 1, note: "OK given in PPM" } })))).toBe("OK given in PPM");
    expect(visible(cardEndLine(card({ status: "gone" })))).toBe("No longer waiting.");
  });
});
