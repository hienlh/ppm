/**
 * The Sessions list is ordered by when each linked session last interacted with this one — a
 * create, a message either way, a reply coming back — newest first, with how long ago on each row.
 * The time is the latest of what the server remembers for the pair and what the loaded messages
 * say; what a linked session does with a third session is never counted. A long list gets a filter.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, installGlobal, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import {
  byRecentInteraction, collectLinkedSessions, LINKED_FILTER_MIN_ROWS, matchesLinkedFilter,
} from "../../../src/web/lib/linked-sessions";
import { formatRelativeDate } from "../../../src/web/lib/format-date";
import type { ChatMessage, SessionInfo } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);
const { act } = await import("react");
const { LinkedSessionsPanel } = await import("../../../src/web/components/chat/linked-sessions-panel");
const { parseSessionLinks } = await import("../../../src/web/lib/session-collab-client");
const { useSessionCollabStore } = await import("../../../src/web/stores/session-collab-store");
const { api } = await import("../../../src/web/lib/api-client");
type LinkedSessionView = import("../../../src/web/hooks/use-linked-sessions").LinkedSessionView;

// Ids of this file only: the stores are module singletons shared with every test file of the run.
const ME = "7ece0000-0000-4000-8000-000000000001";
const PARENT = "7ece0000-0000-4000-8000-000000000000";
const CHILD = "7ece0000-0000-4000-8000-000000000002";
const PEER = "7ece0000-0000-4000-8000-000000000003";
const SENT = "7ece0000-0000-4000-8000-000000000004";
const OLD = "7ece0000-0000-4000-8000-000000000005";

const T = (iso: string) => Date.parse(iso);
const session = (id: string, title: string, spawnedBy: string | null, createdAt: string): SessionInfo =>
  ({ id, providerId: "claude", title, createdAt, spawnedBy, parentTitle: null });

describe("when each linked session last interacted with this one", () => {
  const list = [
    session(ME, "Me", PARENT, "2026-11-10T08:00:00Z"),
    session(PARENT, "Planner", null, "2026-11-01T00:00:00Z"),
    session(CHILD, "Tests", ME, "2026-11-11T09:00:00Z"),
  ];
  const fromPeer = (sentAt: string): ChatMessage => ({
    id: "p", role: "user", timestamp: "2026-11-01T00:00:00Z", content: encodeMessageBlocks("hi", {
      fromSession: { version: 1, sessionId: PEER, providerId: "codex", projectName: "ppm", title: "Peer", sentAt },
    }),
  });
  const send = (target: string, at: string, output?: unknown): ChatMessage => ({
    id: `s-${at}`, role: "assistant", timestamp: at, content: "", events: [
      { type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: target, message: "go" }, toolUseId: `t-${at}` },
      ...(output ? [{ type: "tool_result" as const, toolUseId: `t-${at}`, output: JSON.stringify(output) }] : []),
    ],
  });
  const at = (linked: ReturnType<typeof collectLinkedSessions>) =>
    Object.fromEntries(linked.map((l) => [l.sessionId, l.lastInteractionAt]));

  it("takes a creation from the list, a message in from its sentAt, and a send out from its message", () => {
    const messages = [
      fromPeer("2026-11-12T10:00:00Z"),
      send(CHILD, "2026-11-13T07:00:00Z", { delivered: "inserted", status: { sessionId: CHILD, phase: "idle" } }),
    ];
    expect(at(collectLinkedSessions({ sessionId: ME, list, messages }))).toEqual({
      // This session's own creation is its parent's interaction with it.
      [PARENT]: T("2026-11-10T08:00:00Z"),
      // Messaged after it was created: the later one counts.
      [CHILD]: T("2026-11-13T07:00:00Z"),
      [PEER]: T("2026-11-12T10:00:00Z"),
    });
  });

  it("counts a reply that came back to a waiting send at the reply's time", () => {
    const messages = [send(SENT, "2026-11-13T07:00:00Z", {
      delivered: "inserted", status: { sessionId: SENT, phase: "idle" },
      reply: { replied: true, text: "done", sentAt: "2026-11-13T07:40:00Z" },
    })];
    expect(at(collectLinkedSessions({ sessionId: ME, list: [], messages }))[SENT]).toBe(T("2026-11-13T07:40:00Z"));
  });

  it("keeps the server's time when the messages that knew a later one are no longer loaded", () => {
    const linked = collectLinkedSessions({
      sessionId: ME, list, messages: [fromPeer("2026-11-12T10:00:00Z")],
      liveLinks: { [OLD]: ["messaged"] },
      interactedAt: { [OLD]: T("2026-11-09T00:00:00Z"), [CHILD]: T("2026-11-14T00:00:00Z"), [PEER]: T("2026-11-02T00:00:00Z") },
    });
    expect(at(linked)).toEqual({
      [PARENT]: T("2026-11-10T08:00:00Z"),
      [CHILD]: T("2026-11-14T00:00:00Z"),
      [PEER]: T("2026-11-12T10:00:00Z"),
      [OLD]: T("2026-11-09T00:00:00Z"),
    });
  });

  it("leaves the time out when nothing says one, and ignores a refused send", () => {
    const linked = collectLinkedSessions({
      sessionId: ME, list: [], liveLinks: { [OLD]: ["messaged"] },
      messages: [send(SENT, "2026-11-13T07:00:00Z")],
    });
    expect(linked.map((l) => l.sessionId)).toEqual([OLD]);
    expect("lastInteractionAt" in linked[0]!).toBe(false);
  });
});

describe("byRecentInteraction", () => {
  it("puts the newest first and the unknown last, keeping equals in their order", () => {
    const rows = [
      { id: "a" }, { id: "b", lastInteractionAt: 10 }, { id: "c", lastInteractionAt: 30 },
      { id: "d" }, { id: "e", lastInteractionAt: 10 },
    ];
    expect(byRecentInteraction(rows).map((r) => r.id)).toEqual(["c", "b", "e", "a", "d"]);
  });
});

describe("matchesLinkedFilter", () => {
  it("finds every word in any order, ignoring case and Vietnamese accents", () => {
    expect(matchesLinkedFilter("PSR correction Ireland: tự động hoá", "tu dong")).toBe(true);
    expect(matchesLinkedFilter("PSR correction Ireland: tự động hoá", "IRELAND psr")).toBe(true);
    expect(matchesLinkedFilter("Đối soát lương", "doi soat")).toBe(true);
    expect(matchesLinkedFilter("QL Review PR", "release")).toBe(false);
    expect(matchesLinkedFilter("anything", "   ")).toBe(true);
  });
});

describe("the times the store keeps", () => {
  beforeEach(() => useSessionCollabStore.setState({ links: {}, interactedAt: {}, announced: {}, pendingApprovals: {} }));

  it("reads the server's time with a link, on both sides, and never moves it back", () => {
    expect(parseSessionLinks([
      { sessionId: PEER, relations: ["messaged"], lastInteractionAt: 5_000 },
      { sessionId: OLD, relations: ["child"], lastInteractionAt: "yesterday" },
      { sessionId: SENT, relations: ["child"], lastInteractionAt: -1 },
    ])).toEqual([
      { sessionId: PEER, relations: ["messaged"], lastInteractionAt: 5_000 },
      { sessionId: OLD, relations: ["child"] },
      { sessionId: SENT, relations: ["child"] },
    ]);
    const { seedLinks } = useSessionCollabStore.getState();
    seedLinks(ME, [{ sessionId: PEER, relations: ["messaged"], lastInteractionAt: 5_000 }]);
    seedLinks(ME, [{ sessionId: PEER, relations: ["messaged"], lastInteractionAt: 3_000 }]);
    expect(useSessionCollabStore.getState().interactedAt[ME]).toEqual({ [PEER]: 5_000 });
    expect(useSessionCollabStore.getState().interactedAt[PEER]).toEqual({ [ME]: 5_000 });
  });

  it("stamps a live create and a live link change as interactions", () => {
    const now = spyOn(Date, "now").mockReturnValue(9_000_000);
    try {
      const store = useSessionCollabStore.getState();
      store.sessionCreated({
        type: "session:created", sessionId: CHILD, providerId: "claude", projectName: "ppm", title: "Tests",
        spawnedBy: ME, depth: 1, createdAt: "2026-11-15T00:00:00.000Z",
      } as never);
      store.linkChanged({ type: "session:link_changed", projectName: "ppm", sessionIds: [ME, PEER] });
      expect(useSessionCollabStore.getState().interactedAt[ME]).toEqual({ [CHILD]: T("2026-11-15T00:00:00.000Z"), [PEER]: 9_000_000 });
    } finally {
      now.mockRestore();
    }
  });
});

describe("the Sessions list", () => {
  let view: Mounted | null = null;
  let post: ReturnType<typeof spyOn>;
  beforeEach(() => { post = spyOn(api, "post").mockImplementation((() => Promise.resolve({})) as never); });
  afterEach(async () => {
    await view?.unmount();
    view = null;
    post.mockRestore();
  });

  const HOUR = 3_600_000;
  const kid = (n: number, title: string, hoursAgo: number | null, status: LinkedSessionView["status"] = "idle"): LinkedSessionView => ({
    sessionId: `7ece0000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, title, providerId: "claude",
    relations: ["child"], status, ...(hoursAgo === null ? {} : { lastInteractionAt: Date.now() - hoursAgo * HOUR }),
  });
  const panel = (visible: LinkedSessionView[], hidden: LinkedSessionView[] = []) => (
    <LinkedSessionsPanel projectName="ppm" sessionId={ME} onOpened={() => {}} groups={{ visible, hidden, unlink: () => {}, relink: () => {} }} />
  );
  const titles = () => [...view!.container.querySelectorAll("[data-linked-session]")].map((r) => r.querySelector("button")?.getAttribute("title"));
  const type = async (text: string) => {
    const input = view!.container.querySelector<HTMLInputElement>("[data-linked-filter]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  it("lists the latest interaction first whatever each is doing, and says how long ago", async () => {
    view = await mount(panel([
      kid(1, "Old idle", 50), kid(2, "Waiting on you", 30, "needs_approval"), kid(3, "Never timed", null, "running"),
      kid(4, "Just talked", 0.1), kid(5, "Running", 3, "running"),
    ]));
    expect(titles()).toEqual(["Just talked", "Running", "Waiting on you", "Old idle", "Never timed"]);
    const row = (title: string) => [...view!.container.querySelectorAll("[data-linked-session]")]
      .find((r) => r.querySelector("button")?.getAttribute("title") === title)!;
    const time = (title: string) => row(title).querySelector("[data-linked-interaction]")?.textContent ?? null;
    expect(time("Just talked")).toBe("6m ago");
    expect(time("Running")).toBe("3h ago");
    expect(time("Old idle")).toBe(formatRelativeDate(new Date(Date.now() - 50 * HOUR).toISOString()));
    expect(time("Never timed")).toBeNull();
  });

  it("offers a filter only past eight rows, narrowing by name and reaching the unlinked", async () => {
    const eight = Array.from({ length: LINKED_FILTER_MIN_ROWS }, (_, i) => kid(i + 1, `Session ${i + 1}`, i));
    view = await mount(panel(eight));
    expect(view.container.querySelector("[data-linked-filter]")).toBeNull();
    await view.unmount();

    view = await mount(panel(
      [...eight, kid(20, "NX-6587 Employment Allowance", 1), kid(21, "Brainstorm: GI Group Ireland", 2)],
      [kid(30, "NX-6687 debug: Conaty", 4)],
    ));
    expect(view.container.querySelector("[data-linked-filter]")).not.toBeNull();
    await type("nx");
    expect(titles()).toEqual(["NX-6587 Employment Allowance", "NX-6687 debug: Conaty"]);
    expect(view.container.querySelector("[data-unlinked-toggle]")!.getAttribute("aria-expanded")).toBe("true");
    // The person can still close Unlinked while the search matches in it.
    await act(async () => { view!.container.querySelector<HTMLButtonElement>("[data-unlinked-toggle]")!.click(); });
    expect(view.container.querySelector("[data-unlinked-toggle]")!.getAttribute("aria-expanded")).toBe("false");
    await type("payroll zzz");
    expect(view.container.textContent).toContain("No linked session matches “payroll zzz”.");
    expect(view.container.querySelector("[data-unlinked-toggle]")).toBeNull();
  });

  it("counts unlinked rows toward the threshold, and keeps the box once used", async () => {
    const five = Array.from({ length: 5 }, (_, i) => kid(i + 1, `Session ${i + 1}`, i));
    const four = Array.from({ length: 4 }, (_, i) => kid(i + 40, `Old ${i + 1}`, 30 + i));
    view = await mount(panel(five, four));
    expect(view.container.querySelector("[data-linked-filter]")).not.toBeNull();
    await type("session 2");
    await type("");
    expect(view.container.querySelector("[data-linked-filter]")).not.toBeNull();
  });

  it("unlinks only the matching finished rows while a search is on", async () => {
    const rows = [...Array.from({ length: 8 }, (_, i) => kid(i + 1, `Session ${i + 1}`, i)), kid(20, "NX-1 a", 1), kid(21, "NX-2 b", 2)];
    view = await mount(panel(rows));
    expect(view.container.querySelector("[data-unlink-finished]")!.textContent).toContain("(10)");
    await type("nx");
    expect(view.container.querySelector("[data-unlink-finished]")!.textContent).toContain("(2)");
  });
});
