/**
 * Linked sessions: worked out from the session list, the chat's own messages and the live events
 * with no request; each with a live status; drawn as "session" chips that open the session; and
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
const { LinkedSessionsBarView } = await import("../../../src/web/components/chat/linked-sessions-bar");
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

  it("links the sessions a link change names, and tracks a card until it is resolved", () => {
    handleSessionCollabEvent({ type: "session:link_changed", projectName: "ppm", sessionIds: [ME, PEER] });
    expect(useSessionCollabStore.getState().links[ME]![PEER]).toEqual(["messaged"]);
    handleSessionCollabEvent({ type: "session:collab_approval", projectName: "ppm", sessionId: ME, requestId: "r1", state: "pending" });
    expect(useSessionCollabStore.getState().pendingApprovals[ME]).toBe("r1");
    handleSessionCollabEvent({ type: "session:collab_approval", projectName: "ppm", sessionId: ME, requestId: "r1", state: "resolved" });
    expect(useSessionCollabStore.getState().pendingApprovals[ME]).toBeUndefined();
  });
});

describe("LinkedSessionsBarView", () => {
  let view: Mounted | null = null;
  let post: ReturnType<typeof spyOn>;
  beforeEach(() => { post = spyOn(api, "post").mockImplementation((() => Promise.resolve({})) as never); });
  afterEach(async () => {
    await view?.unmount();
    view = null;
    post.mockRestore();
  });

  const child = { sessionId: CHILD, title: "Tests", providerId: "claude", relations: ["child" as const], status: "running" as const };
  const peer = { sessionId: PEER, title: "Peer", providerId: "codex", relations: ["messaged" as const], status: "new_message" as const };

  it("draws each linked session as a session chip with its live status", async () => {
    view = await mount(<LinkedSessionsBarView projectName="ppm" sessionId={ME} linked={[child, peer]} />);
    const chips = view.container.querySelectorAll("[data-linked-session]");
    expect(chips.length).toBe(2);
    expect(chips[0]!.textContent).toContain("session");
    expect(chips[0]!.getAttribute("data-linked-status")).toBe("running");
    expect(chips[1]!.textContent).toContain("New message");
  });

  it("stops the children only after the user confirms", async () => {
    view = await mount(<LinkedSessionsBarView projectName="ppm" sessionId={ME} linked={[child, peer]} />);
    const stop = [...view.container.querySelectorAll("button")].find((b) => b.textContent === "Stop all child sessions")!;
    await click(stop);
    expect(post).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Stop all")!;
    await click(confirm);
    expect(post).toHaveBeenCalledWith(`/api/project/ppm/chat/sessions/${ME}/stop-children`);
  });

  it("offers no stop while no child runs", async () => {
    view = await mount(<LinkedSessionsBarView projectName="ppm" sessionId={ME} linked={[{ ...child, status: "idle" }, peer]} />);
    expect(view.container.textContent).not.toContain("Stop all child sessions");
  });
});
