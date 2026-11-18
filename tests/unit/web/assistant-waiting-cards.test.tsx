/**
 * "Waiting on you": every red count has exactly its cards behind it, in reach. The list follows
 * the card events and refetches when the counts do not describe it. In the Assistant each waiting
 * card is drawn once, whole, in the stream, and a chip in the footer counts them and asks for
 * a jump to each (the arrows, a press on the dock, a chip's red count, which also moves a filter
 * that hides the card); a filter that hides cards says so. A manager chat's bar shows one card at a
 * time with a pager, opens on a new card, and answers its own reports (not its requests) in place,
 * with a Telegram-style "Replying to card" quote.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const store = await import("../../../src/web/stores/assistant-open-cards-store");
const { applyOpenCard, countsMatch, orderWaitingCards, useOpenCardsStore, focusWaitingCards } = store;
const { WaitingCardsBar, WAITING_HIGHLIGHT_MS } = await import("../../../src/web/components/assistant/waiting-cards-bar");
const { AssistantWaitingChip } = await import("../../../src/web/components/assistant/assistant-waiting-cards");
const { focusTarget, useWaitingCardJump } = await import("../../../src/web/components/assistant/use-waiting-card-jump");
const { jumpToWaitingCard, useWaitingJumpStore } = await import("../../../src/web/stores/assistant-waiting-jump-store");
const { ManagerChatWaitingCards, managerChatWaitingCards } = await import("../../../src/web/components/assistant/manager-chat-waiting-cards");
const { ManagerChip } = await import("../../../src/web/components/assistant/manager-chip");
const { setAssistantCardFilter, useAssistantCardsStore } = await import("../../../src/web/stores/assistant-cards-store");
const { api } = await import("../../../src/web/lib/api-client");
const { resetDecisionSet } = await import("../../../src/web/stores/decision-set-store");
const { act, useRef } = await import("react");
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
  useWaitingJumpStore.setState({ request: null, lit: null });
  // The set of decisions keeps finished tabs while it is open, and counts a card that leaves the
  // waiting list as answered elsewhere: each test starts with neither the last one's list nor tabs.
  await act(async () => { useOpenCardsStore.setState({ cards: null }); });
  resetDecisionSet();
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

describe("a manager chat's bar", () => {
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

/** The Assistant's chip plus its jump hook, as the body mounts them. */
function Assistant() {
  const root = useRef<HTMLDivElement>(null);
  useWaitingCardJump(root);
  return createElement("div", { ref: root }, createElement(AssistantWaitingChip));
}
const jumpedTo = () => useWaitingJumpStore.getState().request?.cardId ?? null;
const dock = () => q("[data-waiting-dock]");
/** The card the chip is on, as its accessible name says (the chip itself shows no title). */
const onCard = () => q("[data-waiting-go]")?.getAttribute("aria-label") ?? null;

describe("in the Assistant", () => {
  it("counts every open card in one footer chip and jumps to each, stepping with the arrows", async () => {
    const a = card({ title: "Ship 0.25.6?" }); const b = card({ projectName: "nxsys", title: "Payroll run" });
    openList = [a, b];
    view = await mount(createElement(Assistant));
    await settle();
    expect(dock()?.getAttribute("data-waiting-count")).toBe("2");
    expect(dock()?.getAttribute("aria-label")).toBe("Waiting on you");
    // Simple: an icon, "Waiting", the count and the pager; no card title, no project.
    expect(dock()?.textContent).toBe("Waiting21/2");
    expect(onCard()).toBe('Go to "Ship 0.25.6?", waiting on you');
    // The chip never draws a card: the stream does.
    expect(q("[data-waiting-card]")).toBeNull();
    expect(q("[data-card-actions]")).toBeNull();
    await click(q("[data-waiting-go]"));
    expect(jumpedTo()).toBe(a.id);
    await click(q('button[aria-label="Next waiting card"]'));
    expect(jumpedTo()).toBe(b.id);
    expect(q("[data-waiting-position]")?.textContent).toBe("2/2");
    expect(onCard()).toBe('Go to "Payroll run", waiting on you');
    await click(q('button[aria-label="Next waiting card"]'));
    expect(jumpedTo()).toBe(a.id);
    await click(q('button[aria-label="Previous waiting card"]'));
    expect(jumpedTo()).toBe(b.id);
    // The footer chips' size, with 44 px hit areas below `md` (an invisible ::after).
    expect(dock()!.className).toContain("h-7");
    expect(dock()!.className).toContain("max-md:h-[26px]");
    expect(q("[data-waiting-go]")!.className).toContain("max-md:after:-inset-y-2.5");
    for (const label of ["Next waiting card", "Previous waiting card"]) {
      const step = q(`button[aria-label="${label}"]`)!.className;
      expect(step).toContain("max-md:size-[22px]");
      expect(step).toContain("max-md:after:-inset-x-[11px]");
      expect(step).toContain("max-md:after:-inset-y-[11px]");
    }
  });

  it("has no pager for one card, names a new card without jumping, and says what a filter hides", async () => {
    const a = card({ title: "Ship 0.25.6?" });
    openList = [a];
    view = await mount(createElement(Assistant));
    await settle();
    expect(q("[data-waiting-pager]")).toBeNull();
    const fresh = card({ projectName: "nxsys", title: "Payroll run" });
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:card", { detail: { card: fresh } })); });
    expect(onCard()).toBe('Go to "Payroll run", waiting on you');
    expect(q("[data-waiting-position]")?.textContent).toBe("2/2");
    // The user may be reading: a card arriving does not move the stream.
    expect(jumpedTo()).toBeNull();
    await act(async () => { setAssistantCardFilter("nxsys"); });
    expect(dock()?.getAttribute("data-waiting-count")).toBe("1");
    expect(q("[data-waiting-elsewhere]")?.textContent).toBe("+1");
    expect(q("[data-waiting-elsewhere]")?.getAttribute("aria-label")).toBe("1 more waiting in other projects: show all projects");
    await act(async () => { setAssistantCardFilter("gone"); });
    expect(q("[data-waiting-go]")).toBeNull();
    expect(q("[data-waiting-elsewhere]")?.textContent).toBe("+2");
    await click(q("[data-waiting-elsewhere]"));
    expect(useAssistantCardsStore.getState().filter).toBeNull();
  });

  it("jumps to a project's first card when its red count is pressed, moving a filter that hides it", async () => {
    const ship = card({ title: "Ship 0.25.6?" });
    openList = [ship, card({ projectName: "nxsys", title: "Payroll run" })];
    view = await mount(createElement("div", null, createElement(ManagerChip, { manager: manager(), waiting: 1 }), createElement(Assistant)));
    await settle();
    await act(async () => { setAssistantCardFilter("nxsys"); });
    const count = q('[data-manager-chip="ppm"] [data-manager-chip-count]')!;
    expect(count.getAttribute("aria-label")).toBe("Show the 1 card from ppm waiting on you");
    expect(count.className).toContain("h-11");
    expect(count.className).toContain("min-w-11");
    await click(count);
    await tick();
    expect(useAssistantCardsStore.getState().filter).toBe("ppm");
    expect(jumpedTo()).toBe(ship.id);
    // The chip is on the card the stream landed on.
    expect(onCard()).toBe('Go to "Ship 0.25.6?", waiting on you');
    await act(async () => { setAssistantCardFilter(null); });
    await act(async () => { focusWaitingCards("nxsys"); });
    await tick();
    expect(onCard()).toBe('Go to "Payroll run", waiting on you');
    expect(q("[data-waiting-position]")?.textContent).toBe("2/2");
    // Taken once: the press does not linger for the next visit.
    expect(useOpenCardsStore.getState().focus).toBeNull();
  });

  it("scrolls only the list holding the card, outlines it, and ignores a jump asked before it mounted", async () => {
    const a = card({ title: "Ship 0.25.6?" });
    openList = [a];
    // A jump asked for while no Assistant was mounted.
    jumpToWaitingCard(a.id);
    const { WaitingStreamCard } = await import("../../../src/web/components/assistant/cards/waiting-stream-card");
    function Body() {
      const root = useRef<HTMLDivElement>(null);
      useWaitingCardJump(root);
      return createElement("div", { ref: root, style: { overflowY: "hidden" } },
        createElement("div", { "data-list": "", style: { overflowY: "auto" } }, createElement(WaitingStreamCard, { card: a })));
    }
    const calls: string[] = [];
    const list = () => q("[data-list]") as HTMLElement;
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = function (this: HTMLElement) { calls.push(this.hasAttribute("data-list") ? "list" : "other"); } as never;
    try {
      view = await mount(createElement(Body));
      await settle();
      await tick();
      expect(calls).toEqual([]);
      expect(q("[data-highlighted]")).toBeNull();
      let height = 1000;
      Object.defineProperty(list(), "scrollHeight", { configurable: true, get: () => height });
      await act(async () => { focusWaitingCards(null, a.id); });
      await tick();
      expect(calls).toEqual(["list"]);
      expect(q("[data-highlighted]")?.getAttribute("data-waiting-card")).toBe(a.id);
      // An older page loading above it grows the list: the card is put back where it landed.
      await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
      height = 2400;
      await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
      expect(calls).toEqual(["list", "list"]);
      // Once the user moves the list themselves, it is theirs.
      await act(async () => { list().dispatchEvent(new Event("wheel")); });
      height = 3800;
      await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
      expect(calls).toEqual(["list", "list"]);
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
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
    view = await mount(createElement(Assistant));
    await settle();
    expect(dock()).not.toBeNull();
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:card", { detail: { card: { ...only, status: "answered" } } })); });
    expect(dock()).toBeNull();
  });

  it("refetches when the announced counts do not describe the list", async () => {
    openList = [card()];
    view = await mount(createElement(Assistant));
    await settle();
    openList = [...openList, card({ title: "Missed while offline" })];
    await act(async () => { window.dispatchEvent(new CustomEvent("assistant:waiting_changed", { detail: { total: 2, byProject: { ppm: 2 } } })); });
    await tick();
    expect(dock()?.getAttribute("data-waiting-count")).toBe("2");
  });

  it("lists the waiting cards when there is no chat to place them in: decisions in their set, the rest whole", async () => {
    const { AssistantWaitingList } = await import("../../../src/web/components/assistant/assistant-waiting-cards");
    openList = [
      card({ title: "Ship 0.25.6?" }), card({ projectName: "nxsys", title: "Payroll run" }),
      card({ kind: "approval", title: "Bash", payload: { requestId: "r" } }),
    ];
    view = await mount(createElement(AssistantWaitingList));
    await settle();
    expect(view.container.querySelectorAll("[data-waiting-list] [data-waiting-card]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-waiting-list] [data-card-actions]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-waiting-list] [data-decision-set] [data-question-tab]")).toHaveLength(2);
  });

  it("asks the server for focus with no Assistant open as a plain store change", () => {
    focusWaitingCards("ppm");
    expect(useOpenCardsStore.getState().focus).toMatchObject({ projectName: "ppm" });
  });
});

describe("in the Assistant's stream", () => {
  it("draws every waiting card the filter lets in, once, even before its page is loaded: decisions in the set at the end", async () => {
    const { streamCards, useAssistantStreamTimeline } = await import("../../../src/web/components/assistant/use-assistant-stream-timeline");
    const loaded = card({ title: "On a loaded page" });
    const older = card({ title: "Older than the loaded pages" });
    const other = card({ projectName: "nxsys", title: "Other project" });
    expect(streamCards([loaded], [loaded, older, other], null).map((c) => c.title)).toEqual(["On a loaded page", "Older than the loaded pages", "Other project"]);
    expect(streamCards([loaded], [loaded, older, other], "ppm").map((c) => c.id)).toEqual([loaded.id, older.id]);

    const approval = card({ kind: "approval", title: "Bash", payload: { requestId: "r" } });
    openList = [older, approval];
    let keep: boolean[] = [];
    let keys: string[] = [];
    function Stream() {
      const items = useAssistantStreamTimeline().build([]).items;
      keep = items.map((i) => !!i.keep);
      keys = items.map((i) => i.key);
      return createElement("div", null, ...items.map((i) => createElement("div", { key: i.key }, i.node)));
    }
    view = await mount(createElement(Stream));
    await settle();
    // Any other waiting card is drawn whole at its place.
    const drawn = view.container.querySelectorAll(`[data-waiting-card="${approval.id}"]`);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.querySelector("[data-card-actions]")?.hasAttribute("data-sticky")).toBe(false);
    // A decision keeps a stub at its place and is answered in the set, the stream's last item.
    expect(view.container.querySelectorAll(`[data-decision-stub="${older.id}"]`)).toHaveLength(1);
    expect(view.container.querySelectorAll(`[data-waiting-card="${older.id}"]`)).toHaveLength(0);
    expect(keys.at(-1)).toBe("decision-set");
    expect(view.container.querySelector(`[data-decision-set] [data-decision-card="${older.id}"]`)).not.toBeNull();
    expect(keep).toEqual([true, true, true]);
    expect(view.container.querySelector("[data-card-pointer]")).toBeNull();
  });
});

describe("in a manager chat", () => {
  it("shows its own decisions as the set, its own only, and leaves its requests out", async () => {
    managers = [manager()];
    openList = [
      card({ title: "Release 0.25.6 now?" }), card({ kind: "urgent", title: "Staging down" }),
      card({ sessionId: "mgr-other", projectName: "other", title: "Not this chat's" }),
      card({ kind: "approval", title: "Bash", payload: { requestId: "r" } }),
    ];
    const { refreshManagerChats } = await import("../../../src/web/hooks/use-manager-chats");
    await refreshManagerChats();
    view = await mount(createElement(ManagerChatWaitingCards, { sessionId: "mgr-ppm" }));
    await settle();
    // One page, the set of this chat's two decisions; the badge counts the two, as the set does.
    expect(q("[data-manager-waiting-cards] [data-waiting-cards]")?.getAttribute("data-waiting-count")).toBe("2");
    expect(q("[data-manager-waiting-cards] [data-waiting-pager]")).toBeNull();
    expect(q("[data-manager-waiting-cards] [data-decision-set]")?.textContent).toContain("2 decisions waiting");
    const tabs = [...view.container.querySelectorAll("[data-decision-set] [data-question-tab]")].map((t) => t.getAttribute("title"));
    expect(tabs).toEqual(["ppm · Staging down", "ppm · Release 0.25.6 now?"]);
    expect(view.container.textContent).not.toContain("Bash");
  });

  it("shows nothing in a chat that is not a manager", async () => {
    managers = [manager()];
    openList = [card({ sessionId: "other" })];
    view = await mount(createElement(ManagerChatWaitingCards, { sessionId: "other" }));
    await settle();
    expect(view.container.textContent).toBe("");
  });
});
