/**
 * The set of decisions on screen: a tab per waiting decision (urgent first), "Send this one" for
 * the card shown, "Send all answered" through a review of every answer, and the three things that
 * happen to a card while the set is open — sent from here, answered elsewhere, changed under the
 * user's pick. Enter moves on and never sends; Ctrl+Enter opens the review.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const openStore = await import("../../../src/web/stores/assistant-open-cards-store");
const { DecisionSet } = await import("../../../src/web/components/assistant/cards/decision-set/decision-set");
const { resetDecisionSet } = await import("../../../src/web/stores/decision-set-store");
const { useWaitingJumpStore } = await import("../../../src/web/stores/assistant-waiting-jump-store");
const { api } = await import("../../../src/web/lib/api-client");
const { act } = await import("react");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const SHA = "a".repeat(64);
let seq = 0;
const card = (over: Partial<Card> = {}, payload: Card["payload"] = {}): Card => {
  seq += 1;
  const id = `0000000${seq}`.slice(-8) + "-2222-2222-2222-222222222222";
  const at = Date.now() - 60_000 + seq;
  return {
    id, kind: "needs_decision", projectName: "alpha", projectKey: "alpha", sessionId: "mgr-alpha",
    title: `Card ${seq}`, body: "", payload, status: "open", answer: null, provenance: null, okOffered: true,
    createdAt: at, updatedAt: at, ...over,
  };
};

let openList: Card[] = [];
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let refuse: Record<string, { status: number; error: string; question?: string; card?: Card }> = {};
/** Runs while a card's answer is out, before the server answers (its card event arriving first). */
let during: Record<string, () => Promise<void>> = {};
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(async () => {
  // Another file's cards may still be in the app's waiting list.
  openStore.useOpenCardsStore.setState({ cards: null, focus: null });
  resetDecisionSet();
  const { ApiError } = await import("../../../src/web/lib/api-client");
  spies.push(spyOn(api, "get").mockImplementation((async (url: string) => {
    if (url.startsWith("/api/assistant/cards/open")) return { cards: openList };
    if (url.startsWith("/api/assistant/managers")) return { managers: [] };
    if (url.startsWith("/api/assistant/cards")) return { cards: [], nextBefore: null };
    return {};
  }) as never));
  spies.push(spyOn(api, "post").mockImplementation((async (url: string, body: Record<string, unknown>) => {
    posts.push({ url, body });
    const id = url.split("/")[4]!;
    // The card as the server held it when the answer came in, before any event moved it.
    const done = openList.find((c) => c.id === id)!;
    await during[id]?.();
    const no = refuse[id];
    if (no) throw new ApiError(no.error, no.status, { ok: false, error: no.error, data: { ...(no.question ? { question: no.question } : {}), ...(no.card ? { card: no.card } : {}) } });
    return { card: { ...done, status: url.endsWith("/dismiss") ? "dismissed" : "answered", answer: { by: "user", channel: "ppm", at: Date.now() } } };
  }) as never));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies.splice(0)) s.mockRestore();
  posts = []; refuse = {}; during = {}; openList = [];
  // The waiting list is the app's, not the set's: a test must not inherit the last one's cards.
  await act(async () => { openStore.useOpenCardsStore.setState({ cards: null, focus: null }); });
  resetDecisionSet();
  useWaitingJumpStore.setState({ request: null, lit: null });
});

const q = (sel: string) => view!.container.querySelector(sel);
const all = (sel: string) => [...view!.container.querySelectorAll(sel)];
const settle = () => act(async () => { openStore.resyncOpenCards(); await new Promise((r) => setTimeout(r, 0)); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const tabTitles = () => all("[data-question-tab]").map((t) => t.getAttribute("title"));
const shown = () => q("[data-decision-card] [data-card-title]")?.textContent ?? q("[data-decision-done]")?.querySelector("h4")?.textContent ?? null;
const key = async (el: Element, k: string, init: KeyboardEventInit = {}) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })); });
};

async function typeReply(text: string) {
  const field = q("[data-decision-reply]") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open(cards: Card[]) {
  openList = cards;
  view = await mount(createElement(DecisionSet));
  await settle();
  await tick();
}

describe("the set", () => {
  it("one tab per waiting decision, urgent first; approvals stay out", async () => {
    const a = card({ title: "Pick the release window" });
    const u = card({ kind: "urgent", projectName: "beta", title: "Deploy is failing" });
    const ap = card({ kind: "approval", title: "Run tests" });
    await open([a, u, ap]);
    expect(tabTitles()).toEqual(["beta · Deploy is failing", "alpha · Pick the release window"]);
    expect(q("[data-decision-set]")?.getAttribute("data-waiting-set")).toBe(`${u.id} ${a.id}`);
  });

  it("send this one: the choice goes alone, its tab is marked sent and the next card shows", async () => {
    const a = card({ title: "Release window" }, { options: [{ id: "tonight", label: "Ship tonight" }, { id: "monday", label: "Monday" }] });
    const b = card({ title: "Second" });
    await open([a, b]);
    expect(shown()).toBe("Release window");
    await click(all("[data-question-option]")[1]!);
    await click(q("[data-decision-send-one]"));
    await tick();
    expect(posts).toEqual([{ url: `/api/assistant/cards/${a.id}/choose`, body: expect.objectContaining({ optionId: "monday" }) }]);
    expect(shown()).toBe("Second");
    await click(all("[data-question-tab]")[0]!);
    expect(q("[data-decision-done='sent'] [data-decision-done-note]")?.textContent).toBe("Chose “Monday”");
    expect(q("[data-decision-send-all]")?.textContent).toContain("(0/1)");
  });

  it("send all goes through the review: every answer listed, a card without one keeps waiting", async () => {
    const d = card({ title: "Weekly status" }, { draft: { to: "#alpha-team", text: "Weekly status\n• done", sha256: SHA } });
    const p = card({ title: "Plain" });
    const w = card({ title: "Not answered" });
    await open([d, p, w]);
    await click(all("[data-question-option]")[0]!);
    await click(all("[data-question-tab]")[1]!);
    await click(all("[data-question-option]")[0]!);
    expect(q("[data-decision-send-all]")?.textContent).toContain("(2/3)");
    await click(q("[data-decision-send-all]"));
    expect(posts).toEqual([]);
    const rows = all("[data-review-row]").map((r) => r.textContent);
    expect(rows[0]).toContain("OK — send the draft to #alpha-team");
    expect(rows[0]).toContain(`sha256 ${SHA.slice(0, 8)}`);
    expect(rows[2]).toContain("keeps waiting");
    await click(q("[data-decision-send-reviewed]"));
    await tick();
    expect(posts.map((x) => x.url)).toEqual([`/api/assistant/cards/${d.id}/ok`, `/api/assistant/cards/${p.id}/ok`]);
    expect(posts[0]!.body).toEqual(expect.objectContaining({ draftSha256: SHA }));
    expect(posts[1]!.body).toEqual(expect.objectContaining({ draftSha256: null }));
  });

  it("a card answered on Telegram while the set is open keeps a struck tab and leaves Send all", async () => {
    const a = card({ title: "First" }, { options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] });
    const b = card({ title: "Second" });
    await open([a, b]);
    await click(all("[data-question-option]")[0]!);
    expect(q("[data-decision-send-all]")?.textContent).toContain("(1/2)");
    openList = [b];
    await settle();
    await tick();
    expect(tabTitles()).toHaveLength(2);
    await click(all("[data-question-tab]")[0]!);
    expect(q("[data-decision-done='elsewhere']")).not.toBeNull();
    expect(q("[data-decision-send-all]")?.textContent).toContain("(0/1)");
  });

  it("a server refusal because someone answered first is said on the card's tab", async () => {
    const a = card({ title: "First" });
    await open([a, card({ title: "Second" })]);
    refuse[a.id] = { status: 409, error: "already_answered", question: "Already answered on Telegram at 21:16.", card: { ...a, status: "answered" } };
    await click(all("[data-question-option]")[0]!);
    await click(q("[data-decision-send-one]"));
    await tick();
    expect(q("[data-decision-done-note]")?.textContent).toBe("Already answered on Telegram at 21:16.");
  });

  it("a sent card keeps its ✓ tab when the server's card event arrives before its answer", async () => {
    const a = card({ title: "First" }, { options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] });
    const b = card({ title: "Second" });
    await open([a, b]);
    await click(all("[data-question-option]")[0]!);
    // As the real server does: the card is marked answered (and announced) before the forward returns.
    during[a.id] = async () => { openList = [b]; openStore.applyOpenCardResult({ ...a, status: "answered" }); };
    await click(q("[data-decision-send-one]"));
    await tick();
    expect(tabTitles()).toEqual(["alpha · First", "alpha · Second"]);
    await click(all("[data-question-tab]")[0]!);
    expect(q("[data-decision-done='sent'] [data-decision-done-note]")?.textContent).toBe("Chose “X”");
  });

  it("its own card leaving the list mid-send is not 'answered elsewhere'; a failed forward keeps the reply", async () => {
    const a = card({ title: "First" });
    const b = card({ title: "Second" });
    await open([a, b]);
    await typeReply("Ship it on Monday");
    // The server marks the card answered (the event arrives) and then the forward fails: it reopens.
    during[a.id] = async () => { openList = [b]; openStore.applyOpenCardResult({ ...a, status: "answered" }); };
    refuse[a.id] = { status: 502, error: "Not sent: the manager chat cannot be found", card: { ...a, answer: { by: "user", channel: "ppm", at: Date.now(), note: "Your answer was not sent to the manager chat. Press it again, or reply." } } };
    await click(q("[data-decision-send-one]"));
    await tick();
    openList = [a, b];
    expect(q("[data-decision-done]")).toBeNull();
    expect(shown()).toBe("First");
    expect((q("[data-decision-reply]") as HTMLTextAreaElement).value).toBe("Ship it on Monday");
    expect(q("[data-decision-notice]")?.textContent).toContain("Not sent");
    expect(q("[data-decision-send-one]")?.hasAttribute("disabled")).toBe(false);
  });

  it("a draft that changes after the OK was picked takes the pick back and says so", async () => {
    const d = card({ title: "Weekly status" }, { draft: { to: "#alpha-team", text: "v1", sha256: SHA } });
    await open([d]);
    await click(all("[data-question-option]")[0]!);
    expect(q("[data-decision-send-one]")?.hasAttribute("disabled")).toBe(false);
    openList = [{ ...d, updatedAt: d.updatedAt + 5_000, payload: { draft: { to: "#alpha-team", text: "v2", sha256: "b".repeat(64) } } }];
    await settle();
    await tick();
    expect(q("[data-decision-send-one]")?.hasAttribute("disabled")).toBe(true);
    expect(q("[data-decision-notice]")?.textContent).toContain("changed after you picked");
    expect(all("[data-question-option][aria-pressed='true']")).toHaveLength(0);
  });

  it("a day-old card's reply asks first; Send anyway sends it with force", async () => {
    const old = card({ title: "Old", createdAt: Date.now() - 2 * 86_400_000 });
    await open([old]);
    const field = q("[data-decision-reply]") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
      set.call(field, "Roll back please");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    refuse[old.id] = { status: 409, error: "confirm", question: "This card is from 14 Nov — send anyway?", card: old };
    await click(q("[data-decision-send-one]"));
    await tick();
    expect(q("[data-decision-confirm]")?.textContent).toContain("send anyway?");
    delete refuse[old.id];
    await click(q("[data-decision-confirm] button"));
    await tick();
    // Its age is confirmed, never forced: a card answered meanwhile would still be refused.
    expect(posts.map((p) => [p.body.force, p.body.confirmAge])).toEqual([[undefined, undefined], [undefined, true]]);
    expect(posts[1]!.body.text).toBe("Roll back please");
  });

  it("a new card gets a tab at the end and does not move the one shown", async () => {
    const a = card({ title: "First" });
    const b = card({ title: "Second" });
    await open([a, b]);
    await click(all("[data-question-tab]")[1]!);
    openList = [a, b, card({ kind: "urgent", title: "New urgent" })];
    await settle();
    await tick();
    expect(shown()).toBe("Second");
    expect(tabTitles()[2]).toBe("alpha · New urgent");
  });

  it("Enter moves to the next card and never sends; Ctrl+Enter opens the review", async () => {
    const a = card({ title: "First" });
    const b = card({ title: "Second" });
    await open([a, b]);
    await click(all("[data-question-option]")[0]!);
    const root = q("[data-decision-set]")!;
    await key(root, "Enter");
    expect(shown()).toBe("Second");
    expect(posts).toEqual([]);
    await key(root, "Enter", { ctrlKey: true });
    expect(q("[data-decision-review]")).not.toBeNull();
    expect(posts).toEqual([]);
  });

  it("folds to one bar naming where the cards come from, and opens again", async () => {
    await open([card(), card({ projectName: "beta" })]);
    await click(q("[data-decision-fold]"));
    expect(q("[data-decision-set='folded']")?.textContent).toContain("alpha 1 · beta 1");
    await click(q("[data-decision-unfold]"));
    expect(q("[data-decision-set='open']")).not.toBeNull();
  });
});
