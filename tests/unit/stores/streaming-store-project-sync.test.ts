import { describe, it, expect, beforeEach } from "bun:test";
import { useStreamingStore, selectAnyStreaming } from "../../../src/web/stores/streaming-store.ts";

/**
 * The streaming set drives the tab-strip spinner and the title/favicon
 * indicator. `/ws/global` delivers phase changes, but anything missed while
 * that socket was down is only recoverable by reconciling against the server's
 * running list — which is scoped to one project at a time.
 */
describe("streaming store — project-scoped sync", () => {
  beforeEach(() => {
    useStreamingStore.setState({ sessions: new Map() });
  });

  it("tracks and clears a session", () => {
    const { setStreaming } = useStreamingStore.getState();
    setStreaming("s1", true, "ppm");
    expect(useStreamingStore.getState().sessions.has("s1")).toBe(true);
    expect(selectAnyStreaming(useStreamingStore.getState())).toBe(true);

    setStreaming("s1", false);
    expect(useStreamingStore.getState().sessions.has("s1")).toBe(false);
    expect(selectAnyStreaming(useStreamingStore.getState())).toBe(false);
  });

  it("keeps a recorded project when a later call omits it", () => {
    const { setStreaming, replaceProjectStreaming } = useStreamingStore.getState();
    setStreaming("s1", true, "ppm");
    setStreaming("s1", true); // e.g. a phase change with no project attached

    replaceProjectStreaming("ppm", []);
    expect(useStreamingStore.getState().sessions.has("s1")).toBe(false);
  });

  it("drops sessions the server no longer reports and adds ones it does", () => {
    const { setStreaming, replaceProjectStreaming } = useStreamingStore.getState();
    setStreaming("stale", true, "ppm");

    replaceProjectStreaming("ppm", ["fresh"]);

    const { sessions } = useStreamingStore.getState();
    expect(sessions.has("stale")).toBe(false);
    expect(sessions.get("fresh")).toBe("ppm");
  });

  it("leaves other projects' sessions untouched", () => {
    const { setStreaming, replaceProjectStreaming } = useStreamingStore.getState();
    setStreaming("other-project", true, "vn-legal-rag");
    setStreaming("unknown-project", true); // project never recorded

    replaceProjectStreaming("ppm", []);

    const { sessions } = useStreamingStore.getState();
    expect(sessions.has("other-project")).toBe(true);
    expect(sessions.has("unknown-project")).toBe(true);
  });

  it("is idempotent — syncing the same list twice changes nothing", () => {
    const { replaceProjectStreaming } = useStreamingStore.getState();
    replaceProjectStreaming("ppm", ["s1", "s2"]);
    const first = [...useStreamingStore.getState().sessions.entries()];

    replaceProjectStreaming("ppm", ["s1", "s2"]);
    expect([...useStreamingStore.getState().sessions.entries()]).toEqual(first);
  });
});
