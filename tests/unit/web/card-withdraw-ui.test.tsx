/**
 * Card withdrawal in the browser: a withdrawn card's status line names what replaced it or why it
 * went, with Restore (and Show new card while that card waits); the card that replaced others says
 * so; a waiting card whose task closed says that; the toast's words; and the chat's tool card for
 * `report_withdraw` and for a report that replaced cards — from real output, an error, and output
 * it cannot read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { AssistantCard } = await import("../../../src/web/components/assistant/cards/assistant-card");
const { cardStatusLine } = await import("../../../src/web/components/assistant/cards/card-shell");
const { withdrawalToastText } = await import("../../../src/web/lib/card-withdrawal-toast");
const { ppmToolSummary, ppmToolIcon } = await import("../../../src/web/lib/ppm-tool-call");
const { useOpenCardsStore } = await import("../../../src/web/stores/assistant-open-cards-store");
const { api } = await import("../../../src/web/lib/api-client");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

const NEW_ID = "22222222-2222-4222-8222-222222222222";
const base = (over: Partial<Card>): Card => ({
  id: "11111111-1111-4111-8111-111111111111", kind: "needs_decision", projectName: "nxsys", projectKey: "k", sessionId: "mgr-1",
  title: "Pay the deposit?", body: "Body", payload: {}, status: "open", answer: null, provenance: null,
  createdAt: Date.now(), updatedAt: Date.now(), ...over,
});
const replaced = base({
  status: "dismissed",
  answer: { by: "manager", channel: "chat", at: Date.now(), note: "Replaced", withdrawn: { sessionId: "mgr-1", reason: "Asked again", supersededBy: { id: NEW_ID, title: "Pay the deposit today?" } } },
});

let view: Mounted | null = null;
let posts: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  posts = [];
  spies.push(spyOn(api, "post").mockImplementation((async (url: string) => { posts.push(url); return {}; }) as never));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies.splice(0)) s.mockRestore();
  useOpenCardsStore.setState({ cards: null });
});

const buttons = () => [...view!.container.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("a withdrawn card", () => {
  it("names the card that replaced it, and offers Show new card while that one waits, and Restore", async () => {
    useOpenCardsStore.setState({ cards: [base({ id: NEW_ID, title: "Pay the deposit today?" })] });
    view = await mount(<AssistantCard card={replaced} />);
    expect(view.container.querySelector("[data-card-status-line]")?.textContent).toStartWith("Replaced by “Pay the deposit today?”");
    expect(buttons()).toEqual(["Show new card", "Restore"]);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Restore"))!);
    expect(posts).toEqual([`/api/assistant/cards/${replaced.id}/restore`]);
  });

  it("offers only Restore once the new card no longer waits", async () => {
    useOpenCardsStore.setState({ cards: [] });
    view = await mount(<AssistantCard card={replaced} />);
    expect(buttons()).toEqual(["Restore"]);
  });

  it("says why a card was withdrawn without a replacement, and nothing for the user's own dismissal", () => {
    const why = base({ status: "dismissed", answer: { by: "manager", channel: "chat", at: 0, withdrawn: { sessionId: "m", reason: "You paid it" } } });
    expect(cardStatusLine(why)).toStartWith("Withdrawn by the manager: You paid it");
    expect(cardStatusLine(base({ status: "dismissed", answer: { by: "user", channel: "ppm", at: 0 } }))).toStartWith("Dismissed");
    expect(cardStatusLine(base({ kind: "done", status: "dismissed", answer: { by: "ppm", channel: "ppm", at: 0, note: "Task nxsys/7 was closed" } })))
      .toStartWith("Task nxsys/7 was closed");
  });

  it("has no Restore when the user dismissed it", async () => {
    view = await mount(<AssistantCard card={base({ status: "dismissed", answer: { by: "user", channel: "ppm", at: 0 } })} />);
    expect(view.container.querySelector("[data-card-withdrawn-actions]")).toBeNull();
  });

  it("toasts once with Undo for a withdrawal, never for anything else", () => {
    expect(withdrawalToastText(replaced)).toEqual({ title: "The nxsys manager replaced a card", description: "“Pay the deposit?” → “Pay the deposit today?”" });
    expect(withdrawalToastText(base({ status: "dismissed", answer: { by: "user", channel: "ppm", at: 0 } }))).toBeNull();
  });
});

describe("cards that replaced others or lost their task", () => {
  it("says which cards a card replaces", async () => {
    view = await mount(<AssistantCard card={base({ payload: { supersedes: [{ id: "a", title: "Old one" }] } })} />);
    expect(view.container.querySelector("[data-card-replaces]")?.textContent).toBe("Replaces an earlier card: “Old one”");
  });

  it("says a waiting card's task was closed, and keeps Dismiss", async () => {
    view = await mount(<AssistantCard card={base({ payload: { aboutTask: { taskId: "t", ref: "nxsys/7" }, taskClosed: { closedAs: "done", at: 1 } } })} />);
    expect(view.container.querySelector("[data-card-task-closed]")?.textContent).toContain("Task nxsys/7 was closed (done)");
    expect(buttons()).toContain("Dismiss");
  });
});

describe("the chat's card for report_withdraw", () => {
  const blocks = (text: string) => JSON.stringify([{ type: "text", text }]);
  const tool = "mcp__ppm-sessions__report_withdraw";

  it("reads the answer: how many went and why", () => {
    const out = blocks(JSON.stringify({ withdrawn: [{ card: "a", outcome: "withdrawn" }, { card: "b", outcome: "not_yours" }], note: "" }));
    expect(ppmToolSummary(tool, { cards: ["a", "b"], reason: "Handled by the user" }, { output: out, isError: false }))
      .toEqual({ label: "Withdrew cards", detail: "1 of 2 cards · Handled by the user" });
    expect(ppmToolIcon(tool)).toBe("report");
  });

  it("reads a listing", () => {
    const out = blocks(JSON.stringify({ listed: [{ id: "a" }, { id: "b" }], note: "" }));
    expect(ppmToolSummary(tool, {}, { output: out, isError: false })).toEqual({ label: "Listed open cards", detail: "2 waiting" });
  });

  it("falls back to the input on an error or odd output, never undefined", () => {
    const err = ppmToolSummary(tool, { cards: ["a"], reason: "stale" }, { output: blocks("Only a project's manager chat can report"), isError: true });
    expect(err?.detail).toBe("1 card · stale");
    const odd = ppmToolSummary(tool, { cards: ["a", "b"], reason: "x" }, { output: "<<not json>>", isError: false });
    expect(odd?.label).toBeTruthy();
    expect(odd?.detail).toBe("2 cards · x");
    expect(JSON.stringify(odd)).not.toContain("undefined");
  });

  it("adds what a report replaced to its line", () => {
    const out = blocks(JSON.stringify({ cardId: NEW_ID, kind: "needs_decision", withdrawn: [{ card: "a", outcome: "withdrawn" }] }));
    expect(ppmToolSummary("ppm_sessions:report_to_assistant", { kind: "needs_decision", title: "Pay today?", supersedes: ["a"] }, { output: out, isError: false })?.detail)
      .toBe("Needs decision · Pay today? · replaces 1");
  });
});
