/**
 * A manager chat's "Waiting on you" on a phone, and a waiting card's place in the Assistant's
 * stream. On a phone the bar is one row and opening it shows the card full screen (a sheet with the
 * pager and a close button), so no half-screen card sits over the chat; a new card does not take
 * the screen by itself. In the Assistant's stream a waiting card is drawn whole, its buttons at its
 * end (never stuck over the messages), and a jump to it outlines it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { WaitingCardsBar } = await import("../../../src/web/components/assistant/waiting-cards-bar");
const { WaitingStreamCard } = await import("../../../src/web/components/assistant/cards/waiting-stream-card");
const { focusTarget } = await import("../../../src/web/components/assistant/use-waiting-card-jump");
const { lightWaitingCard, useWaitingJumpStore } = await import("../../../src/web/stores/assistant-waiting-jump-store");
const { useOpenCardsStore } = await import("../../../src/web/stores/assistant-open-cards-store");
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
    expect(row.className).toContain("min-h-[26px]");
    expect(view.container.querySelector("[data-waiting-summary]")?.textContent).toBe("ppm · Release 0.25.6 tonight?");

    await click(row);
    expect(sheet()?.getAttribute("role")).toBe("dialog");
    // The sheet takes the whole visible height.
    expect(sheet()!.parentElement!.className).toContain("h-[calc(var(--sheet-vh,100dvh)+var(--sheet-kb,0px))]");
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

  it("does not take the screen for a card nobody asked to see", async () => {
    const a = card();
    view = await mount(createElement(WaitingCardsBar, { cards: [a], label: "Waiting on you" }));
    const fresh = card({ title: "Fresh" });
    await view.rerender(createElement(WaitingCardsBar, { cards: [a, fresh], label: "Waiting on you" }));
    expect(sheet()).toBeNull();
    expect(view.container.querySelector("[data-waiting-summary]")?.textContent).toBe("ppm · Fresh");
  });

  it("keeps the sheet's own bottom padding, takes focus and gives it back", async () => {
    view = await mount(createElement(WaitingCardsBar, { cards: [card()], label: "Waiting on you" }));
    const row = view.container.querySelector<HTMLButtonElement>("[data-waiting-toggle]")!;
    await click(row);
    const panel = sheet()!.parentElement!;
    // `p-0` would merge away the panel's home-indicator and keyboard padding.
    expect(panel.className).not.toMatch(/(^|\s)p-0(\s|$)/);
    expect(panel.className).toContain("pb-[");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close the waiting cards");
    const { act } = await import("react");
    await act(async () => { sheet()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("gets out of the way when a manager chat opens", async () => {
    const { MANAGER_CHAT_OPENING_EVENT } = await import("../../../src/web/components/assistant/open-manager-chat");
    view = await mount(createElement(WaitingCardsBar, { cards: [card()], label: "Waiting on you" }));
    await click(view.container.querySelector("[data-waiting-toggle]"));
    expect(sheet()).not.toBeNull();
    const { act } = await import("react");
    await act(async () => { window.dispatchEvent(new Event(MANAGER_CHAT_OPENING_EVENT)); });
    expect(sheet()).toBeNull();
  });

  it("does not turn a desktop's unfolded box into a sheet when the width drops below md", async () => {
    setWidth(1280);
    view = await mount(createElement(WaitingCardsBar, { cards: [card()], label: "Waiting on you" }));
    expect(view.container.querySelector("[data-waiting-slot] [data-waiting-card]")).not.toBeNull();
    const { act } = await import("react");
    await act(async () => { setWidth(744); });
    expect(sheet()).toBeNull();
    expect(view.container.querySelector("[data-waiting-toggle]")).not.toBeNull();
  });
});

describe("a waiting card in the Assistant's stream", () => {
  it("is drawn whole, its buttons at its end, and a jump outlines it", async () => {
    const a = card({ title: "Duyệt kế hoạch (7 phase)", okOffered: true });
    view = await mount(createElement(WaitingStreamCard, { card: a }));
    const box = view.container.querySelector(`[data-waiting-card="${a.id}"]`)!;
    expect(box.textContent).toContain("A long body");
    expect(box.querySelector("[data-card-text]")?.hasAttribute("data-folded")).toBe(false);
    const actions = box.querySelector("[data-card-actions]")!;
    // At the card's end, and not stuck over the messages below it.
    expect(actions).not.toBeNull();
    expect(actions.hasAttribute("data-sticky")).toBe(false);
    expect([...actions.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("OK");
    // Each button is the chip row's 26px on a phone.
    for (const b of actions.querySelectorAll("button")) expect(b.className).toContain("h-[26px]");
    expect(box.hasAttribute("data-highlighted")).toBe(false);
    const { act } = await import("react");
    await act(async () => { lightWaitingCard(a.id); });
    expect(box.hasAttribute("data-highlighted")).toBe(true);
    await act(async () => { useWaitingJumpStore.setState({ lit: null }); });
    expect(box.hasAttribute("data-highlighted")).toBe(false);
  });

  it("lands on the card named, before the project's first", () => {
    const first = card(); const named = card();
    expect(focusTarget([first, named], "ppm", named.id)?.id).toBe(named.id);
    expect(focusTarget([first, named], "ppm")?.id).toBe(first.id);
    expect(focusTarget([first, named], "ppm", "gone")?.id).toBe(first.id);
  });
});
