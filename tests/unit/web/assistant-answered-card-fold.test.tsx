/**
 * A decision the user already answered folds to one line in the Assistant's stream: its title,
 * project, how it ended and when, in a row sized by its content (no 44 px minimum) that opens the card again (read-only, no
 * buttons) and folds it back. A card still waiting is never folded, and the waiting dock counts
 * only those.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AnsweredCardFold, answerSummary, isAnsweredDecision } = await import("../../../src/web/components/assistant/cards/answered-card-fold");
const { answeredCardPreview } = await import("../../../src/web/components/assistant/cards/answered-card-preview");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

let seq = 0;
const card = (over: Partial<Card> = {}): Card => {
  seq += 1;
  return {
    id: `${String(seq).padStart(8, "0")}-3333-3333-3333-333333333333`, kind: "needs_decision", projectName: "ppm", projectKey: "k",
    sessionId: "mgr-ppm", title: `Ship 0.26.${seq}?`, body: "Tests pass.\n\nShip tonight?", payload: {}, status: "answered",
    answer: { by: "user", channel: "ppm", at: Date.now(), ok: true, note: "OK given in PPM" },
    provenance: null, createdAt: 1_000 + seq, updatedAt: 1_000 + seq, okOffered: true, ...over,
  };
};

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });
const q = (sel: string) => view!.container.querySelector(sel);

describe("an answered decision in the stream", () => {
  it("is folded only once it no longer waits, and only for kinds that asked the user", () => {
    expect(isAnsweredDecision(card())).toBe(true);
    expect(isAnsweredDecision(card({ status: "dismissed" }))).toBe(true);
    expect(isAnsweredDecision(card({ kind: "approval", status: "resolved" }))).toBe(true);
    expect(isAnsweredDecision(card({ status: "open", answer: null }))).toBe(false);
    // A report that never asked anything stays as it is.
    expect(isAnsweredDecision(card({ kind: "done", status: "info", answer: null }))).toBe(false);
  });

  it("says how it ended without repeating the time", () => {
    expect(answerSummary(card())).toBe("OK given in PPM");
    expect(answerSummary(card({ answer: { by: "user", channel: "ppm", at: Date.now(), choice: { id: "a", label: "Tonight" }, note: "Chose \"Tonight\" in PPM" } }))).toBe("Chose \"Tonight\" in PPM");
    expect(answerSummary(card({ status: "dismissed" }))).toBe("Dismissed");
    expect(answerSummary(card({ status: "gone", answer: null }))).toBe("No longer waiting");
  });

  it("is one line, with no 44 px minimum, that opens the card read-only and folds it again", async () => {
    const c = card({ followUp: { text: "Shipped.", at: Date.now() } as Card["followUp"] });
    view = await mount(createElement(AnsweredCardFold, { card: c }));
    const line = q("[data-answered-toggle]")!;
    expect(line.className).not.toContain("min-h-11");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(q("[data-answered-title]")?.textContent).toBe(c.title);
    expect(line.textContent).toContain("ppm");
    expect(q("[data-answered-summary]")?.textContent).toBe("OK given in PPM");
    expect(q("[data-answered-followup]")).not.toBeNull();
    expect(q("[data-assistant-card]")).toBeNull();
    await click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    const full = q("[data-assistant-card]")!;
    expect(full.textContent).toContain("Ship tonight?");
    // Read-only: how it ended, and no buttons to answer it again.
    expect(full.querySelector("[data-card-actions]")).toBeNull();
    expect(full.querySelector("[data-card-status-line]")?.textContent).toContain("OK given in PPM");
    await click(line);
    expect(q("[data-assistant-card]")).toBeNull();
  });

  it("stays open across a remount (the stream re-places cards as messages arrive)", async () => {
    const c = card();
    view = await mount(createElement(AnsweredCardFold, { card: c }));
    await click(q("[data-answered-toggle]"));
    await view.unmount();
    view = await mount(createElement(AnsweredCardFold, { card: c }));
    expect(q("[data-assistant-card]")).not.toBeNull();
    await click(q("[data-answered-toggle]"));
  });
});

describe("the preview of the manager's answer on a folded card", () => {
  const followUp = (over: Partial<NonNullable<Card["followUp"]>>): Card["followUp"] => ({ text: "", truncated: false, at: Date.now(), ...over });

  it("is nothing until the manager answered", () => {
    expect(answeredCardPreview(card())).toBeNull();
    expect(answeredCardPreview(card({ followUp: followUp({}) }))).toBeNull();
  });

  it("shows the reply and the answer as plain text, cut with …", () => {
    const text = "**Không ạ** — chạy cái này *tốn nhiều quota*:\n- Full regression: ~40% quota tuần.\n- Còn lại 15%.\n" + "Chi tiết thêm. ".repeat(40);
    const p = answeredCardPreview(card({ followUp: followUp({ text, reply: "Có tốn quota không?" }) }))!;
    expect(p.reply).toBe("Có tốn quota không?");
    expect(p.answer.startsWith("Không ạ — chạy cái này tốn nhiều quota: Full regression: ~40% quota tuần. Còn lại 15%.")).toBe(true);
    expect(p.answer).not.toContain("*");
    expect(p.answer.endsWith("…")).toBe(true);
    expect(Array.from(p.answer).length).toBeLessThanOrEqual(280);
  });

  it("marks an answer the server had cut already, and names a new card as the answer", () => {
    expect(answeredCardPreview(card({ followUp: followUp({ text: "Ngắn.", truncated: true }) }))!.answer).toBe("Ngắn…");
    const p = answeredCardPreview(card({ followUp: followUp({ newCards: [{ id: "n1", title: "Chạy lại?" }, { id: "n2", title: "Khác" }] }) }))!;
    expect(p).toEqual({ reply: "", answer: "New card: “Chạy lại?” and 1 more" });
  });

  it("is drawn folded under the summary, two lines at most, and gone once the card is open", async () => {
    const c = card({ followUp: followUp({ text: "## Đã xong\n\nĐã merge **PR #12**.", reply: "merge đi em" }) });
    view = await mount(createElement(AnsweredCardFold, { card: c }));
    expect(q("[data-answered-reply]")?.textContent).toBe("You: merge đi em");
    const answer = q("[data-answered-answer]")!;
    expect(answer.textContent).toBe("Manager: Đã xong Đã merge PR #12.");
    expect(answer.className).toContain("line-clamp-2");
    expect(q("[data-answered-reply]")!.className).toContain("truncate");
    await click(q("[data-answered-toggle]"));
    expect(q("[data-answered-preview]")).toBeNull();
    expect(q("[data-card-followup]")).not.toBeNull();
    await click(q("[data-answered-toggle]"));
  });

  it("leaves a card with no answer under it as it was", async () => {
    view = await mount(createElement(AnsweredCardFold, { card: card() }));
    expect(q("[data-answered-preview]")).toBeNull();
    expect(q("[data-answered-toggle]")!.className).toContain("items-center");
  });
});
