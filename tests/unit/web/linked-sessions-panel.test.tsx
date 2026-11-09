/**
 * Linked sessions: worked out from the session list, the chat's own messages and the live events
 * with no request; each with a live status; drawn as a chip in the footer's context row; and
 * "Stop all child sessions" only while a child runs, behind a confirmation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, installGlobal, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import { collectLinkedSessions, linkedSessionStatus } from "../../../src/web/lib/linked-sessions";
import type { ChatMessage, SessionInfo } from "../../../src/types/chat";

installDom();
afterAll(uninstallDom);
// The desktop confirmation is a Radix dialog, whose focus scope watches the DOM.
installGlobal("MutationObserver", (window as unknown as { MutationObserver: unknown }).MutationObserver);
const { act, useState } = await import("react");
const { LinkedSessionsPanel, UNDO_MS } = await import("../../../src/web/components/chat/linked-sessions-panel");
const { ActivityChip } = await import("../../../src/web/components/chat/activity-chip");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
type LinkedSessionView = import("../../../src/web/hooks/use-linked-sessions").LinkedSessionView;
const { handleSessionCollabEvent } = await import("../../../src/web/lib/session-collab-events");
const { useSessionCollabStore } = await import("../../../src/web/stores/session-collab-store");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { api } = await import("../../../src/web/lib/api-client");

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const PARENT = "aaaaaaaa-0000-4000-8000-000000000000";
const CHILD = "cccccccc-2222-4000-8000-000000000002";
const PEER = "dddddddd-3333-4000-8000-000000000003";
const NEW = "eeeeeeee-4444-4000-8000-000000000004";

const session = (id: string, title: string, spawnedBy: string | null = null): SessionInfo =>
  ({ id, providerId: "claude", title, createdAt: "2026-11-06T00:00:00Z", spawnedBy, parentTitle: null });

describe("collectLinkedSessions", () => {
  it("finds the creator and children in the list, and a sender and a target in the messages", () => {
    const list = [session(ME, "Me", PARENT), session(PARENT, "Planner"), session(CHILD, "Tests", ME)];
    const messages: ChatMessage[] = [
      { id: "1", role: "user", timestamp: "", content: encodeMessageBlocks("hi", {
        fromSession: { version: 1, sessionId: PEER, providerId: "codex", projectName: "ppm", title: "Peer", sentAt: "2026-11-06T00:00:00.000Z" },
      }) },
      { id: "2", role: "assistant", timestamp: "", content: "", events: [
        { type: "tool_use", tool: "mcp__ppm-sessions__send_to_session", input: { session_id: CHILD, message: "go" }, toolUseId: "t1" },
      ] },
    ];
    const linked = collectLinkedSessions({ sessionId: ME, list, messages });
    expect(linked.map((l) => [l.sessionId, l.title, l.relations])).toEqual([
      [PARENT, "Planner", ["parent"]],
      // Messaging a child keeps it a child.
      [CHILD, "Tests", ["child"]],
      [PEER, "Peer", ["messaged"]],
    ]);
    expect(linked.find((l) => l.sessionId === PEER)!.providerId).toBe("codex");
  });

  it("never lists the session itself", () => {
    expect(collectLinkedSessions({ sessionId: ME, list: [session(ME, "Me", ME)], messages: [] })).toEqual([]);
  });
});

describe("linkedSessionStatus", () => {
  const none = { streaming: new Map(), notifications: new Map(), pendingApprovals: {} };
  it("puts waiting on the user first, then running, then an unread answer", () => {
    expect(linkedSessionStatus(CHILD, none)).toBe("idle");
    expect(linkedSessionStatus(CHILD, { ...none, streaming: new Map([[CHILD, "ppm"]]) })).toBe("running");
    expect(linkedSessionStatus(CHILD, { ...none, notifications: new Map([[CHILD, { count: 1, type: "done" }]]) })).toBe("new_message");
    expect(linkedSessionStatus(CHILD, {
      streaming: new Map([[CHILD, "ppm"]]), notifications: new Map(), pendingApprovals: { [CHILD]: "r1" },
    })).toBe("needs_approval");
  });
});

describe("global events", () => {
  beforeEach(() => {
    useSessionCollabStore.setState({ links: {}, announced: {}, pendingApprovals: {} });
    useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never });
  });

  it("adds a created session to the list and links it to its creator", () => {
    handleSessionCollabEvent({
      type: "session:created", sessionId: NEW, providerId: "codex", projectName: "ppm", title: "Fresh",
      spawnedBy: ME, depth: 1, createdAt: "2026-11-06T01:00:00.000Z",
    });
    const rows = useSessionListStore.getState().byProject[projectCacheId({ name: "ppm", path: "/p" })]!.sessions;
    expect(rows.find((s) => s.id === NEW)).toMatchObject({ title: "Fresh", spawnedBy: ME, providerId: "codex" });
    expect(useSessionCollabStore.getState().links[ME]![NEW]).toEqual(["child"]);
    expect(useSessionCollabStore.getState().links[NEW]![ME]).toEqual(["parent"]);
  });

  it("names the creator from the event when the list never loaded it", () => {
    const unlisted = "ffffffff-5555-4000-8000-000000000005";
    const child = "ffffffff-6666-4000-8000-000000000006";
    handleSessionCollabEvent({
      type: "session:created", sessionId: child, providerId: "claude", projectName: "ppm", title: "Helper",
      spawnedBy: unlisted, parentTitle: "Planner", parentProviderId: "codex", depth: 1, createdAt: "2026-11-06T01:00:00.000Z",
    });
    const rows = useSessionListStore.getState().byProject[projectCacheId({ name: "ppm", path: "/p" })]!.sessions;
    expect(rows.some((s) => s.id === unlisted)).toBe(false);
    expect(rows.find((s) => s.id === child)).toMatchObject({ spawnedBy: unlisted, parentTitle: "Planner" });
    expect(useSessionCollabStore.getState().announced[unlisted]).toEqual({ title: "Planner", providerId: "codex", projectName: "ppm" });
  });

  it("keeps a created session listed through a sync that does not list it yet (no transcript)", async () => {
    const fresh = "ffffffff-7777-4000-8000-000000000007";
    const project = { name: "ppm", path: "/p" };
    const get = spyOn(api, "get").mockImplementation((async (url: string) =>
      url.includes("/tags") ? { tags: [], counts: {}, defaultTagId: null } : { sessions: [session(ME, "Me")], hasMore: false }
    ) as typeof api.get);
    try {
      handleSessionCollabEvent({
        type: "session:created", sessionId: fresh, providerId: "claude", projectName: "ppm", title: "Count TS",
        spawnedBy: ME, parentTitle: "Me", parentProviderId: "claude", depth: 1, createdAt: "2026-11-06T02:00:00.000Z",
      });
      await useSessionListStore.getState().sync(project);
      const rows = useSessionListStore.getState().byProject[projectCacheId(project)]!.sessions;
      expect(rows.find((s) => s.id === fresh)).toMatchObject({ title: "Count TS", spawnedBy: ME, parentTitle: "Me" });
      expect(rows.some((s) => s.id === ME)).toBe(true);
    } finally {
      get.mockRestore();
    }
  });

  it("links the sessions a link change names, and tracks a card until it is resolved", () => {
    handleSessionCollabEvent({ type: "session:link_changed", projectName: "ppm", sessionIds: [ME, PEER] });
    expect(useSessionCollabStore.getState().links[ME]![PEER]).toEqual(["messaged"]);
    handleSessionCollabEvent({ type: "session:collab_approval", projectName: "ppm", sessionId: ME, requestId: "r1", state: "pending" });
    expect(useSessionCollabStore.getState().pendingApprovals[ME]).toBe("r1");
    handleSessionCollabEvent({ type: "session:collab_approval", projectName: "ppm", sessionId: ME, requestId: "r1", state: "resolved" });
    expect(useSessionCollabStore.getState().pendingApprovals[ME]).toBeUndefined();
  });
});

describe("LinkedSessionsPanel (the activity chip's Sessions tab)", () => {
  let view: Mounted | null = null;
  let post: ReturnType<typeof spyOn>;
  beforeEach(() => {
    post = spyOn(api, "post").mockImplementation((() => Promise.resolve({})) as never);
  });
  afterEach(async () => {
    await view?.unmount();
    view = null;
    post.mockRestore();
  });

  const parent = { sessionId: PARENT, title: "Planner", providerId: "claude", relations: ["parent" as const], status: "idle" as const };
  const child = { sessionId: CHILD, title: "Tests", providerId: "claude", relations: ["child" as const], status: "running" as const };
  const peer = { sessionId: PEER, title: "Peer", providerId: "codex", relations: ["messaged" as const], status: "new_message" as const };

  /** The panel over a list it can unlink from and relink to, the way `useLinkedSessionGroups` drives it. */
  function Harness({ initial }: { initial: LinkedSessionView[] }) {
    const [hiddenIds, setHidden] = useState<string[]>([]);
    const groups = {
      visible: initial.filter((l) => !hiddenIds.includes(l.sessionId)),
      hidden: initial.filter((l) => hiddenIds.includes(l.sessionId)),
      unlink: (ids: readonly string[]) => setHidden((h) => [...h, ...ids]),
      relink: (ids: readonly string[]) => setHidden((h) => h.filter((id) => !ids.includes(id))),
    };
    return <LinkedSessionsPanel projectName="ppm" sessionId={ME} groups={groups} onOpened={() => {}} />;
  }
  const action = (id: string) => view!.container.querySelector<HTMLButtonElement>(`[data-linked-session="${id}"] [data-unlink-action]`)!;
  const button = (text: string) => [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;
  const settle = (ms = 250) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  it("groups the sessions by how they are linked, with a status on each row and no SESSION badge", async () => {
    view = await mount(<Harness initial={[parent, child, peer]} />);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Created this session");
    expect(text).toContain("Created by this session");
    expect(text).toContain("Messaged");
    expect(text).not.toContain("SESSION");
    const row = view.container.querySelector(`[data-linked-session="${CHILD}"]`)!;
    expect(row.getAttribute("data-linked-status")).toBe("running");
    expect(row.textContent).toContain("Running");
  });

  it("lists what needs the person first, then what runs, then unread answers, then the idle", async () => {
    const kid = (n: number, status: LinkedSessionView["status"]) => ({
      sessionId: `cccccccc-0000-4000-8000-00000000000${n}`, title: `Kid ${n}`, providerId: "claude", relations: ["child" as const], status,
    });
    view = await mount(<Harness initial={[kid(1, "idle"), kid(2, "new_message"), kid(3, "running"), kid(4, "idle"), kid(5, "needs_approval")]} />);
    const order = [...view.container.querySelectorAll("[data-linked-session]")].map((r) => r.textContent?.match(/Kid \d/)?.[0]);
    expect(order).toEqual(["Kid 5", "Kid 3", "Kid 2", "Kid 1", "Kid 4"]);
  });

  it("stops the children only after the user confirms", async () => {
    view = await mount(<Harness initial={[child, peer]} />);
    await click(button("Stop all child sessions"));
    expect(post).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-stop-children-confirm]")).not.toBeNull();
    await click(button("Stop 1 session"));
    expect(post).toHaveBeenCalledWith(`/api/project/ppm/chat/sessions/${ME}/stop-children`);
  });

  it("offers no stop while no child runs, and Cancel brings the button back", async () => {
    view = await mount(<Harness initial={[{ ...child, status: "idle" }, peer]} />);
    expect(button("Stop all child sessions")).toBeNull();
    await view.unmount();
    view = await mount(<Harness initial={[child]} />);
    await click(button("Stop all child sessions"));
    await click(button("Cancel"));
    expect(post).not.toHaveBeenCalled();
    expect(button("Stop all child sessions")).not.toBeNull();
  });

  it("will not unlink a session that is still running, and says why", async () => {
    view = await mount(<Harness initial={[child, peer]} />);
    const blocked = action(CHILD);
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.getAttribute("title")).toContain("stop it before unlinking");
    await click(blocked);
    await settle();
    expect(view.container.querySelector(`[data-linked-session="${CHILD}"] [data-unlink-action="busy"]`)).not.toBeNull();
    expect(view.container.querySelector("[data-unlinked-toggle]")).toBeNull();
  });

  it("unlinks one session, offers Undo, and keeps it under Unlinked with Relink", async () => {
    view = await mount(<Harness initial={[parent, child, peer]} />);
    await click(action(PEER));
    await settle();
    // Gone from its group, and the Messaged heading with it.
    expect(view.container.textContent).not.toContain("Messaged");
    const undo = view.container.querySelector("[data-undo-bar]")!;
    expect(undo.textContent).toContain("Unlinked “Peer”");
    const toggle = view.container.querySelector<HTMLButtonElement>("[data-unlinked-toggle]")!;
    expect(toggle.textContent).toContain("1");
    await click(toggle);
    const relink = action(PEER);
    expect(relink.getAttribute("data-unlink-action")).toBe("relink");
    await click(relink);
    expect(view.container.textContent).toContain("Messaged");
    expect(view.container.querySelector("[data-unlinked-toggle]")).toBeNull();
    expect(view.container.querySelector("[data-undo-bar]")).toBeNull();
  });

  it("unlinks every idle and finished session at once, leaving the running ones, and Undo puts them back", async () => {
    view = await mount(<Harness initial={[parent, child, peer]} />);
    const all = button("Unlink idle & done")!;
    expect(all.textContent).toContain("(2)");
    await click(all);
    await settle();
    expect(view.container.querySelector("[data-undo-bar]")!.textContent).toContain("Unlinked 2 sessions");
    expect(view.container.querySelector("[data-unlinked-toggle]")!.textContent).toContain("2");
    // Only the running child is left, so there is nothing more to unlink at once.
    expect(button("Unlink idle & done")).toBeNull();
    await click(button("Undo"));
    expect(view.container.querySelector("[data-unlinked-toggle]")).toBeNull();
    expect(button("Unlink idle & done")!.textContent).toContain("(2)");
  });

  it("keeps an unlink made just before the popover closes", async () => {
    const unlinked: string[] = [];
    const groups = { visible: [peer], hidden: [], unlink: (ids: readonly string[]) => unlinked.push(...ids), relink: () => {} };
    view = await mount(<LinkedSessionsPanel projectName="ppm" sessionId={ME} groups={groups} onOpened={() => {}} />);
    await click(action(PEER));
    // Closed while the row is still sliding out.
    await view.unmount();
    view = null;
    expect(unlinked).toEqual([PEER]);
  });

  it("drops the Undo bar after six seconds", async () => {
    view = await mount(<Harness initial={[peer]} />);
    await click(action(PEER));
    await settle();
    expect(view.container.querySelector("[data-undo-bar]")).not.toBeNull();
    await settle(UNDO_MS + 100);
    expect(view.container.querySelector("[data-undo-bar]")).toBeNull();
  }, UNDO_MS + 4000);
});

describe("ActivityChip: sessions", () => {
  let view: Mounted | null = null;
  // A chat no earlier test linked anything to, so only these messages decide its list.
  const CHAT = "99999999-9999-4000-8000-000000000009";
  beforeEach(() => {
    useSessionCollabStore.setState({ links: {}, announced: {}, pendingApprovals: {} });
    useSettingsStore.setState({ unlinkedSessions: {} });
  });
  afterEach(async () => { await view?.unmount(); view = null; });

  const fromPeer = (at: string): ChatMessage => ({
    id: `from-${at}`, role: "user", timestamp: at, content: encodeMessageBlocks("hi", {
      fromSession: { version: 1, sessionId: PEER, providerId: "codex", projectName: "ppm", title: "Peer", sentAt: at },
    }),
  });
  const chipFor = (messages: ChatMessage[]) => mount(<ActivityChip projectName="ppm" agentProviderId="claude" sessionId={CHAT}
    messages={messages} teamName={CHAT} teamMembers={[]} />);

  it("shows the linked count, opens on Sessions, and turns red while one needs the person", async () => {
    view = await chipFor([fromPeer("2026-11-06T00:00:00.000Z")]);
    const chip = view.container.querySelector("[data-activity-chip]")!;
    expect(chip.textContent).toContain("1");
    expect(chip.textContent).toContain("linked");
    expect(view.container.querySelector('[data-activity-part="agents"]')).toBeNull();
    expect(chip.getAttribute("data-activity-dot")).toBe("idle");

    await act(async () => { useSessionCollabStore.setState({ pendingApprovals: { [PEER]: "r1" } }); });
    expect(chip.getAttribute("data-activity-dot")).toBe("needs_approval");
    expect(chip.className).toContain("border-error");
    await click(chip);
    // No agents run: the Agents tab is not offered at all.
    expect(view.container.querySelector('[data-activity-tab="agents"]')).toBeNull();
    expect(view.container.querySelector('[data-activity-tab="sessions"]')!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps an unlinked session hidden, and shows it again once it messages this chat after the unlink", async () => {
    const first = fromPeer("2026-11-06T00:00:00.000Z");
    useSettingsStore.setState({ unlinkedSessions: { [CHAT]: { [PEER]: Date.parse("2026-11-07T00:00:00.000Z") } } });
    view = await chipFor([first]);
    const part = () => view!.container.querySelector('[data-activity-part="sessions"]')!.textContent;
    expect(part()).toContain("0");
    await view.rerender(<ActivityChip projectName="ppm" agentProviderId="claude" sessionId={CHAT}
      messages={[first, fromPeer("2026-11-08T00:00:00.000Z")]} teamName={CHAT} teamMembers={[]} />);
    expect(part()).toContain("1");
  });
});
