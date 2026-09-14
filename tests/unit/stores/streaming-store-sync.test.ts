import { describe, it, expect, beforeEach } from "bun:test";
import { useStreamingStore, selectProjectStreaming } from "../../../src/web/stores/streaming-store.ts";

/**
 * The streaming set drives the tab-strip spinner, the title/favicon indicator and the screen
 * wake lock. `/ws/global` delivers phase changes, but anything missed while that socket was
 * down is only recoverable by reconciling against the server's running list.
 */

/** The wake lock's gate — app-wide, unlike every other consumer (`use-wake-lock.ts`). */
const anyRunning = () => useStreamingStore.getState().sessions.size > 0;
const store = () => useStreamingStore.getState();

beforeEach(() => {
  useStreamingStore.setState({ sessions: new Map() });
});

describe("streaming store — per-project reads", () => {
  it("tracks and clears a session", () => {
    store().setStreaming("s1", true, "ppm");
    expect(store().sessions.has("s1")).toBe(true);
    expect(selectProjectStreaming("ppm")(store())).toBe(true);

    store().setStreaming("s1", false);
    expect(store().sessions.has("s1")).toBe(false);
    expect(selectProjectStreaming("ppm")(store())).toBe(false);
  });

  it("a busy project does not make another project's window look busy", () => {
    // The bug this selector exists for: /ws/global carries phase changes for every project,
    // so "is anything streaming" was true in every open window. Three workspaces in three
    // PWA windows, one of them working, three identical busy icons.
    store().setStreaming("s1", true, "boilerplate");

    expect(selectProjectStreaming("boilerplate")(store())).toBe(true);
    expect(selectProjectStreaming("nxsys-workspace")(store())).toBe(false);
    expect(selectProjectStreaming("UnlockEd")(store())).toBe(false);
  });

  it("reports nothing before a project is known", () => {
    // First paint, before the active project resolves: an undefined project matches nothing
    // rather than everything.
    store().setStreaming("s1", true, "ppm");
    expect(selectProjectStreaming(undefined)(store())).toBe(false);
  });
});

describe("streaming store — app-wide reconcile", () => {
  it("drops sessions the server no longer reports and adds ones it does", () => {
    store().setStreaming("stale", true, "ppm");

    store().replaceAllStreaming([{ sessionId: "fresh", projectName: "ppm" }]);

    expect(store().sessions.has("stale")).toBe(false);
    expect(store().sessions.get("fresh")).toBe("ppm");
  });

  it("clears a stale entry belonging to a project the user is not looking at", () => {
    // The reconcile used to take a project and only delete entries tagged with it, so an entry
    // from any other project survived every sync for the life of the page. Invisible to the
    // favicon and title, which filter by project — but not to the wake lock, which asks
    // whether anything at all is running, and so never let the screen sleep again.
    store().setStreaming("sess-alpha", true, "alpha");
    store().setStreaming("sess-untagged", true); // phase change that carried no project

    // The server reports nothing running, whichever project happens to be on screen.
    store().replaceAllStreaming([]);

    expect(anyRunning()).toBe(false);
  });

  it("is idempotent — syncing the same list twice changes nothing", () => {
    const running = [
      { sessionId: "s1", projectName: "ppm" },
      { sessionId: "s2", projectName: "ppm" },
    ];
    store().replaceAllStreaming(running);
    const first = [...store().sessions.entries()];

    store().replaceAllStreaming(running);
    expect([...store().sessions.entries()]).toEqual(first);
  });
});

describe("streaming store — re-keyed sessions", () => {
  it("forgets the old id when the server migrates a session", () => {
    // Codex re-keys every session (its thread id is not PPM's) and CLI providers do it once
    // they read their real id. Every later phase change uses the new id, so the old one's
    // `idle` never arrives and it would otherwise sit in the map forever.
    store().setStreaming("ppm-id", true, "alpha");

    store().dropSession("ppm-id");
    store().setStreaming("codex-thread-id", true, "alpha");
    store().setStreaming("codex-thread-id", false, "alpha");

    expect(anyRunning()).toBe(false);
  });

  it("ignores a migration for a session it never tracked", () => {
    store().setStreaming("live", true, "alpha");
    const before = store().sessions;

    store().dropSession("never-seen");

    // Same object: an unrelated rename must not churn a new Map and re-render every consumer.
    expect(store().sessions).toBe(before);
  });
});
