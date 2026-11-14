/**
 * "Waiting on you" on a phone, and a waiting card's place in the stream. On a phone the bar is one
 * row and opening it shows the card full screen (a sheet with the pager and a close button), so no
 * half-screen card sits over the chat; a new card does not take the screen by itself; replying in
 * the Assistant's composer moves the sheet aside. In the stream, a card the bar holds is only
 * named, with "Show" opening the bar on exactly that card, so its buttons never appear twice.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { WaitingCardsBar } = await import("../../../src/web/components/assistant/waiting-cards-bar");
const { WaitingCardPointer, POINTER_NOTE } = await import("../../../src/web/components/assistant/cards/waiting-card-pointer");
const { focusTarget } = await import("../../../src/web/components/assistant/assistant-waiting-cards");
const { useOpenCardsStore } = await import("../../../src/web/stores/assistant-open-cards-store");
const { useCardReplyStore } = await import("../../../src/web/stores/assistant-card-reply-store");
const { api } = await import("../../../src/web/lib/api-client");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;

let seq = 0;
const card = (over: Partial<Card> = {}): Card => {
  seq += 1;
  return {
    id: `${String(seq).padStart(8, "0")}-2222-2222-2222-222222222222`, kind: "needs_decision", projectName: "ppm", projectKey: "k",
    sessionId: "mgr-ppm", title: `Card ${seq}`, body: "A long body.\n\nWith paragraphs.", payload: {}, status: "open", answer: null,
    provenance: null, createdAt: 1_000 + seq, updatedAt: 1_000 + seq, ...over,
  };
};

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
let width = 1024;
function setWidth(w: number) {
  width = w;
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => width });
  window.dispatchEvent(new Event("resize"));
}
beforeEach(() => {
  setWidth(390);
  spies.push(spyOn(api, "post").mockImplementation((async () => ({})) as never));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies.splice(0)) s.mockRestore();
  useCardReplyStore.getState().close();
  useOpenCardsStore.setState({ focus: null });
  setWidth(1024);
});

const sheet = () => document.querySelector("[data-waiting-sheet]");
const inSheet = (sel: string) => sheet()?.querySelector(sel) ?? null;

describe("on a phone", () => {
  it("is one row that opens the card full screen, with the pager and a close button", async () => {
    const a = card({ title: "Release 0.25.6 tonight?" }); const b = card({ title: "NX-6294: staging job" });
    view = await mount(createElement(WaitingCardsBar, { cards: [a, b], label: "Waiting on you" }));
    // Folded: no card under the row, nothing over the chat.
    expect(view.container.querySelector("[data-waiting-card]")).toBeNull();
    expect(sheet()).toBeNull();
    const row = view.container.querySelector("[data-waiting-toggle]")!;
    expect(row.className).toContain("min-h-11");
    expect(view.container.querySelector("[data-waiting-summary]")?.textContent).toBe("ppm · Release 0.25.6 tonight?");

    await click(row);
    expect(sheet()?.getAttribute("role")).toBe("dialog");
    // The sheet takes the whole visible height.
    expect(sheet()!.parentElement!.className).toContain("h-[var(--sheet-vh)]");
    expect(inSheet("[data-waiting-card] h4")?.textContent).toBe("Release 0.25.6 tonight?");
    expect(inSheet("[data-waiting-position]")?.textContent).toBe("1/2");
    // Its buttons stick to the sheet's bottom while the card scrolls.
    expect(inSheet("[data-card-actions]")?.hasAttribute("data-sticky")).toBe(true);
    await click(inSheet('button[aria-label="Next waiting card"]'));
    expect(inSheet("[data-waiting-card] h4")?.textContent).toBe("NX-6294: staging job");
    const close = inSheet('button[aria-label="Close the waiting cards"]')!;
    expect(close.className).toContain("size-11");
    await click(close);
    expect(sheet()).toBeNull();
  });

  it("does not take the screen for a card nobody asked to see, but a press on a count opens it", async () => {
    const a = card();
    view = await mount(createElement(WaitingCardsBar, { cards: [a], label: "Waiting on you" }));
    const fresh = card({ title: "Fresh" });
    await view.rerender(createElement(WaitingCardsBar, { cards: [a, fresh], label: "Waiting on you" }));
    expect(sheet()).toBeNull();
    expect(view.container.querySelector("[data-waiting-summary]")?.textContent).toBe("ppm · Fresh");
    await view.rerender(createElement(WaitingCardsBar, { cards: [a, fresh], label: "Waiting on you", focus: { cardId: a.id, nonce: 1 } }));
    expect(inSheet("[data-waiting-card]")?.getAttribute("data-waiting-card")).toBe(a.id);
    expect(inSheet("[data-highlighted]")).not.toBeNull();
  });

  it("steps aside when the user replies in the Assistant's composer", async () => {
    const a = card();
    view = await mount(createElement(WaitingCardsBar, { cards: [a], label: "Waiting on you" }));
    await click(view.container.querySelector("[data-waiting-toggle]"));
    await click([...sheet()!.querySelectorAll("button")].find((b) => b.textContent === "Reply")!);
    expect(useCardReplyStore.getState().target?.cardId).toBe(a.id);
    expect(sheet()).toBeNull();
  });
});

describe("a waiting card in the stream", () => {
  it("is only named, and Show opens the bar on exactly that card", async () => {
    setWidth(1280);
    const a = card({ title: "Duyệt kế hoạch (7 phase)", okOffered: true });
    view = await mount(createElement(WaitingCardPointer, { card: a }));
    expect(view.container.querySelector("[data-card-pointer]")).not.toBeNull();
    expect(view.container.querySelector("[data-card-actions]")).toBeNull();
    expect([...view.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Show"]);
    expect(view.container.textContent).toContain(POINTER_NOTE);
    expect(view.container.textContent).not.toContain("A long body");
    await click(view.container.querySelector("button"));
    expect(useOpenCardsStore.getState().focus).toMatchObject({ projectName: "ppm", cardId: a.id });
  });

  it("lands on the card named, before the project's first", () => {
    const first = card(); const named = card();
    expect(focusTarget([first, named], "ppm", named.id)?.id).toBe(named.id);
    expect(focusTarget([first, named], "ppm")?.id).toBe(first.id);
    expect(focusTarget([first, named], "ppm", "gone")?.id).toBe(first.id);
  });
});

