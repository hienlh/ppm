/**
 * "Waiting on you": every red count has exactly its cards behind it, in reach. The list follows
 * the card events and refetches when the counts do not describe it; the bar shows one card at a
 * time with a pager, opens on a new card, and a chip's red count lands it on that project's first
 * card, outlined; a filter that hides cards says so; a manager chat shows its own reports (not its
 * requests) and answers them in place, with a Telegram-style "Replying to card" quote.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const store = await import("../../../src/web/stores/assistant-open-cards-store");
const { applyOpenCard, countsMatch, orderWaitingCards, useOpenCardsStore, focusWaitingCards } = store;
const { WaitingCardsBar, WAITING_HIGHLIGHT_MS } = await import("../../../src/web/components/assistant/waiting-cards-bar");
const { AssistantWaitingCards, focusTarget } = await import("../../../src/web/components/assistant/assistant-waiting-cards");
const { ManagerChatWaitingCards, managerChatWaitingCards } = await import("../../../src/web/components/assistant/manager-chat-waiting-cards");
const { ManagerChip } = await import("../../../src/web/components/assistant/manager-chip");
const { setAssistantCardFilter, useAssistantCardsStore } = await import("../../../src/web/stores/assistant-cards-store");
const { api } = await import("../../../src/web/lib/api-client");
const { act } = await import("react");
type Card = import("../../../src/shared/assistant-cards").AssistantCard;
type Manager = import("../../../src/shared/assistant-managers").ManagerChatSummary;

let seq = 0;
const card = (over: Partial<Card> = {}): Card => {
  seq += 1;
  const id = `0000000${seq}`.slice(-8) + "-1111-1111-1111-111111111111";
  return {
    id, kind: "needs_decision", projectName: "ppm", projectKey: "k", sessionId: "mgr-ppm",
    title: `Card ${seq}`, body: "", payload: {}, status: "open", answer: null, provenance: null,
    createdAt: 1_000 + seq, updatedAt: 1_000 + seq, ...over,
  };
};
const manager = (over: Partial<Manager> = {}): Manager => ({
  projectName: "ppm", projectPath: "/p/ppm", sessionId: "mgr-ppm", providerId: "claude", title: "Quản lý", phase: "idle",
  permissionMode: "bypassPermissions", digest: false, telegramDetail: "full", waiting: 0, rulesPending: false, ...over,
});

let openList: Card[] = [];
let managers: Manager[] = [];
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(spyOn(api, "get").mockImplementation((async (url: string) => {
    if (url.startsWith("/api/assistant/cards/open")) return { cards: openList };
    if (url.startsWith("/api/assistant/managers")) return { managers };
    if (url.startsWith("/api/assistant/cards")) return { cards: [], nextBefore: null };
    return {};
  }) as never));
  spies.push(spyOn(api, "post").mockImplementation((async () => ({})) as never));
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of spies.splice(0)) s.mockRestore();
  setAssistantCardFilter(null);
  useOpenCardsStore.setState({ focus: null });
});

const q = (sel: string) => view!.container.querySelector(sel);
const shownTitle = () => q("[data-waiting-card] h4")?.textContent ?? null;
// The store follows the server once per page; each test asks it to read the list again.
const settle = () => act(async () => { store.resyncOpenCards(); await new Promise((r) => setTimeout(r, 0)); });
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("the list behind the counts", () => {
  it("keeps a card while it waits and drops it once answered, oldest first", () => {
    const a = card(); const b = card();
    let list = applyOpenCard([], b);
    list = applyOpenCard(list, a);
    expect(list.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(applyOpenCard(list, { ...a, status: "answered" }).map((c) => c.id)).toEqual([b.id]);
    // A card that never waits (a done report) never joins.
    expect(applyOpenCard(list, card({ kind: "done" }))).toHaveLength(2);
  });

  it("steps urgent first, then the oldest; a red count lands on its project's first card", () => {
    const old = card({ projectName: "nxsys" }); const mid = card(); const hot = card({ kind: "urgent" });
    const ordered = orderWaitingCards([mid, hot, old]);
    expect(ordered.map((c) => c.id)).toEqual([hot.id, old.id, mid.id]);
    expect(focusTarget(ordered, "nxsys")?.id).toBe(old.id);
    expect(focusTarget(ordered, null)?.id).toBe(hot.id);
    expect(focusTarget(ordered, "gone")?.id).toBe(hot.id);
  });

  it("tells counts that describe the list from counts that do not", () => {
    const list = [card(), card({ projectName: "nxsys" }), card({ projectName: null })];
    expect(countsMatch(list, { total: 3, byProject: { ppm: 1, nxsys: 1 } })).toBe(true);
    expect(countsMatch(list, { total: 3, byProject: { ppm: 2 } })).toBe(false);
    expect(countsMatch(list, { total: 2, byProject: { ppm: 1, nxsys: 1 } })).toBe(false);
  });

  it("shows a manager chat its own reports only, not its requests nor another chat's", () => {
    const mine = card(); const req = card({ kind: "approval" }); const other = card({ sessionId: "mgr-x" });
    expect(managerChatWaitingCards([mine, req, other], "mgr-ppm").map((c) => c.id)).toEqual([mine.id]);
  });
});

describe("the bar", () => {
  it("shows one card with its count and steps to the next, outlining it", async () => {
    const a = card({ title: "First" }); const b = card({ title: "Second" });
    view = await mount(createElement(WaitingCardsBar, { cards: [a, b], label: "Waiting on you" }));
    expect(q("[data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("2");
    expect(q("[data-waiting-position]")?.textContent).toBe("1/2");
    expect(shownTitle()).toBe("First");
    expect(q("[data-highlighted]")).toBeNull();
    // In the bar the buttons stick to its bottom while a long card scrolls.
    expect(q("[data-waiting-card] [data-card-actions]")?.hasAttribute("data-sticky")).toBe(true);
    await click(q('button[aria-label="Next waiting card"]'));
    expect(q("[data-waiting-position]")?.textContent).toBe("2/2");
    expect(shownTitle()).toBe("Second");
    expect(q("[data-highlighted]")).not.toBeNull();
    await click(q('button[aria-label="Next waiting card"]'));
    expect(shownTitle()).toBe("First");
    // Folded, it still names the card.
    await click(q("[data-waiting-toggle]"));
    expect(q("[data-waiting-slot]")).toBeNull();
    expect(q("[data-waiting-summary]")?.textContent).toBe("ppm · First");
    // The phone hit areas.
    expect(q("[data-waiting-toggle]")!.className).toContain("min-h-11");
    expect(q('button[aria-label="Next waiting card"]')!.className).toContain("size-11");
  });

  it("opens on a card that arrives, and the outline goes after a moment", async () => {
    const a = card({ title: "First" });
    view = await mount(createElement(WaitingCardsBar, { cards: [a], label: "Waiting on you" }));
    expect(q("[data-waiting-pager]")).toBeNull();
    await click(q("[data-waiting-toggle]"));
    const b = card({ title: "Fresh" });
    await view.rerender(createElement(WaitingCardsBar, { cards: [a, b], label: "Waiting on you" }));
    expect(shownTitle()).toBe("Fresh");
    expect(q("[data-highlighted]")).not.toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, WAITING_HIGHLIGHT_MS + 50)); });
    expect(q("[data-highlighted]")).toBeNull();
  });

  it("stays at the answered card's place, which now holds the next one", async () => {
    const a = card({ title: "A" }); const b = card({ title: "B" }); const c = card({ title: "C" });
    view = await mount(createElement(WaitingCardsBar, { cards: [a, b, c], label: "Waiting on you" }));
    await click(q('button[aria-label="Next waiting card"]'));
    await view.rerender(createElement(WaitingCardsBar, { cards: [a, c], label: "Waiting on you" }));
    expect(shownTitle()).toBe("C");
    expect(q("[data-waiting-position]")?.textContent).toBe("2/2");
  });
});

describe("in the Assistant", () => {
  it("lists every open card the counts are made of, and says what a filter hides", async () => {
    openList = [card({ title: "Ship 0.25.6?" }), card({ projectName: "nxsys", title: "Payroll run" })];
    view = await mount(createElement(AssistantWaitingCards));
    await settle();
    expect(q("[data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("2");
    expect(q("[data-waiting-cards]")?.textContent).toContain("Waiting on you");
    await act(async () => { setAssistantCardFilter("nxsys"); });
    expect(q("[data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("1");
    expect(shownTitle()).toBe("Payroll run");
    expect(q("[data-waiting-elsewhere]")?.textContent).toContain("1 more waiting in other projects");
    await click([...view.container.querySelectorAll("[data-waiting-elsewhere] button")][0]!);
    expect(useAssistantCardsStore.getState().filter).toBeNull();
  });

  it("lands on a project's first card when its red count is pressed, moving a filter that hides it", async () => {
    openList = [card({ title: "Ship 0.25.6?" }), card({ projectName: "nxsys", title: "Payroll run" })];
    view = await mount(createElement("div", null, createElement(ManagerChip, { manager: manager(), waiting: 1 }), createElement(AssistantWaitingCards)));
    await settle();
    await act(async () => { setAssistantCardFilter("nxsys"); });
    expect(shownTitle()).toBe("Payroll run");
    const count = q('[data-manager-chip="ppm"] [data-manager-chip-count]')!;
    expect(count.getAttribute("aria-label")).toBe("Show the 1 card from ppm waiting on you");
    // 44 × 44 below `md`.
    expect(count.className).toContain("h-11");
    expect(count.className).toContain("min-w-11");
    await click(count);
    await tick();
    expect(useAssistantCardsStore.getState().filter).toBe("ppm");
    expect(shownTitle()).toBe("Ship 0.25.6?");
    expect(q("[data-highlighted]")).not.toBeNull();
    // Taken once: the press does not linger for the next visit.
    expect(useOpenCardsStore.getState().focus).toBeNull();
    // Nor for the next filter change, which mounts the bar afresh.
    await act(async () => { setAssistantCardFilter(null); });
    await tick();
    expect(q("[data-highlighted]")).toBeNull();
    expect(q("[data-waiting-position]")?.textContent).toBe("1/2");
  });

  it("keeps the first list when a card changes while it loads", async () => {
    const first = card({ title: "There from the start" });
    openList = [first];
    // The answer to the first read is held until a card event has landed.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let reads = 0;
    (spies[0] as unknown as { mockImplementation(f: unknown): void }).mockImplementation((async (url: string) => {
      if (url.startsWith("/api/assistant/cards/open")) { reads += 1; if (reads === 1) await gate; return { cards: openList }; }
      return {};
    }) as never);
    await act(async () => { useOpenCardsStore.setState({ cards: null }); store.resyncOpenCards(); });
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:card", { detail: { card: card({ kind: "done" }) } })); });
    release();
    await tick();
    await tick();
    expect(reads).toBe(2);
    expect(useOpenCardsStore.getState().cards?.map((c) => c.title)).toEqual(["There from the start"]);
  });

  it("disappears once nothing waits", async () => {
    const only = card({ title: "Last one" });
    openList = [only];
    view = await mount(createElement(AssistantWaitingCards));
    await settle();
    expect(q("[data-waiting-cards]")).not.toBeNull();
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:card", { detail: { card: { ...only, status: "answered" } } })); });
    expect(q("[data-waiting-cards]")).toBeNull();
  });

  it("refetches when the announced counts do not describe the list", async () => {
    openList = [card()];
    view = await mount(createElement(AssistantWaitingCards));
    await settle();
    openList = [...openList, card({ title: "Missed while offline" })];
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:waiting_changed", { detail: { total: 2, byProject: { ppm: 2 } } })); });
    await tick();
    expect(q("[data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("2");
  });

  it("asks the server for focus with no Assistant open as a plain store change", () => {
    focusWaitingCards("ppm");
    expect(useOpenCardsStore.getState().focus).toMatchObject({ projectName: "ppm" });
  });
});

describe("in a manager chat", () => {
  it("shows its own open report and answers it in place, with a Telegram-style quote", async () => {
    managers = [manager()];
    openList = [card({ title: "Release 0.25.6 now?" }), card({ kind: "approval", title: "Bash", payload: { requestId: "r" } })];
    const { refreshManagerChats } = await import("../../../src/web/hooks/use-manager-chats");
    await refreshManagerChats();
    view = await mount(createElement(ManagerChatWaitingCards, { sessionId: "mgr-ppm" }));
    await settle();
    expect(q("[data-manager-waiting-cards] [data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("1");
    const labels = [...view.container.querySelectorAll("[data-waiting-card] button")].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Reply", "Dismiss"]);
    await click([...view.container.querySelectorAll("button")].find((b) => b.textContent === "Reply")!);
    expect(q("[data-card-reply-quote]")?.textContent).toContain("Replying to card");
    expect(q("[data-card-reply-title]")?.textContent).toBe("ppm · Release 0.25.6 now?");
    await click(q('button[aria-label="Stop replying to this card"]'));
    expect(q("[data-card-reply-bar]")).toBeNull();
  });

  it("shows nothing in a chat that is not a manager", async () => {
    managers = [manager()];
    openList = [card({ sessionId: "other" })];
    view = await mount(createElement(ManagerChatWaitingCards, { sessionId: "other" }));
    await settle();
    expect(view.container.textContent).toBe("");
  });
});
