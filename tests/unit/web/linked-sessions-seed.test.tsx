/**
 * Linked sessions are seeded from the server's link store when a chat is opened: links older than
 * the loaded messages, or from before a restart, reach the bar without waiting for an event. The
 * seed is additive (a live link that arrived first survives) and a malformed response is dropped.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { parseSessionLinks, fetchSessionLinks } = await import("../../../src/web/lib/session-collab-client");
const { useSessionCollabStore } = await import("../../../src/web/stores/session-collab-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useLinkedSessions } = await import("../../../src/web/hooks/use-linked-sessions");
const { api } = await import("../../../src/web/lib/api-client");

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
const PARENT = "aaaaaaaa-0000-4000-8000-000000000000";
const PEER = "dddddddd-3333-4000-8000-000000000003";
const OLD = "ffffffff-5555-4000-8000-000000000005";

const { act } = await import("react");
/** Lets the links request settle and React apply what it stored. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("parseSessionLinks", () => {
  it("keeps well-formed links and drops everything else", () => {
    expect(parseSessionLinks([
      { sessionId: PARENT, relations: ["parent"] },
      { sessionId: PEER, relations: ["messaged", "messaged", "bogus"] },
      { sessionId: "", relations: ["child"] },
      { sessionId: OLD, relations: [] },
      { sessionId: OLD, relations: "child" },
      null,
      "x",
    ])).toEqual([
      { sessionId: PARENT, relations: ["parent"] },
      { sessionId: PEER, relations: ["messaged"] },
    ]);
    expect(parseSessionLinks({ data: [] })).toEqual([]);
    expect(parseSessionLinks(null)).toEqual([]);
  });
});

describe("seedLinks", () => {
  beforeEach(() => useSessionCollabStore.setState({ links: {}, announced: {}, pendingApprovals: {} }));

  it("records both sides of every relation and keeps a live link that came first", () => {
    useSessionCollabStore.getState().linkChanged({ type: "session:link_changed", projectName: "ppm", sessionIds: [ME, PEER] });
    useSessionCollabStore.getState().seedLinks(ME, [
      { sessionId: PARENT, relations: ["parent"] },
      { sessionId: PEER, relations: ["messaged"] },
      { sessionId: OLD, relations: ["child", "messaged"] },
    ]);
    const { links } = useSessionCollabStore.getState();
    expect(links[ME]).toEqual({ [PEER]: ["messaged"], [PARENT]: ["parent"], [OLD]: ["child", "messaged"] });
    expect(links[PARENT]![ME]).toEqual(["child"]);
    expect(links[OLD]![ME]).toEqual(["parent", "messaged"]);
  });

  it("changes nothing when every link is already known", () => {
    useSessionCollabStore.getState().seedLinks(ME, [{ sessionId: PEER, relations: ["messaged"] }]);
    const before = useSessionCollabStore.getState().links;
    useSessionCollabStore.getState().seedLinks(ME, [{ sessionId: PEER, relations: ["messaged"] }]);
    expect(useSessionCollabStore.getState().links).toBe(before);
  });
});

describe("useLinkedSessions seeding", () => {
  let view: Mounted | null = null;
  let get: ReturnType<typeof spyOn>;
  const served: Record<string, unknown> = {
    [ME]: [{ sessionId: OLD, relations: ["messaged"] }],
    [OTHER]: [{ sessionId: PARENT, relations: ["parent"] }],
  };

  beforeEach(() => {
    useSessionCollabStore.setState({ links: {}, announced: {}, pendingApprovals: {} });
    useProjectStore.setState({ projects: [{ name: "ppm", path: "/p" }] as never });
    get = spyOn(api, "get").mockImplementation(((path: string) => {
      const id = decodeURIComponent(path.split("/sessions/")[1]!.split("/")[0]!);
      return Promise.resolve(served[id] ?? []);
    }) as never);
  });
  afterEach(async () => {
    await view?.unmount();
    view = null;
    get.mockRestore();
  });

  function Probe({ id }: { id: string }) {
    const linked = useLinkedSessions("ppm", id, []);
    return <div data-ids={linked.map((l) => `${l.sessionId}:${l.relations.join("+")}`).join(",")} />;
  }
  const shown = () => view!.container.querySelector("div")!.getAttribute("data-ids");

  it("asks the server for the session's links and shows them, again when the session changes", async () => {
    view = await mount(<Probe id={ME} />);
    await settle();
    await view.rerender(<Probe id={ME} />);
    expect(get).toHaveBeenCalledWith(`/api/project/ppm/chat/sessions/${ME}/links`, expect.anything());
    expect(shown()).toBe(`${OLD}:messaged`);

    await view.rerender(<Probe id={OTHER} />);
    await settle();
    await view.rerender(<Probe id={OTHER} />);
    expect(get).toHaveBeenCalledTimes(2);
    expect(shown()).toBe(`${PARENT}:parent`);
  });

  it("keeps working from live events when the request fails", async () => {
    get.mockImplementation((() => Promise.reject(new Error("offline"))) as never);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      view = await mount(<Probe id={ME} />);
      await settle();
      await act(async () => {
        useSessionCollabStore.getState().linkChanged({ type: "session:link_changed", projectName: "ppm", sessionIds: [ME, PEER] });
      });
      expect(shown()).toBe(`${PEER}:messaged`);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("fetchSessionLinks validates what the server answered", async () => {
    get.mockImplementation((() => Promise.resolve([{ sessionId: PEER, relations: ["messaged"] }, { nope: 1 }])) as never);
    expect(await fetchSessionLinks("ppm", ME)).toEqual([{ sessionId: PEER, relations: ["messaged"] }]);
  });
});
