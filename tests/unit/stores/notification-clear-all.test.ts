/**
 * clearAll — the bell's "Clear all" has to reach the server, not just the local Map.
 *
 * Wiping state alone made the button look like it worked and then hand every entry back
 * on the next loadFromServer, so this pins the request that marks the sessions read —
 * including the ones a per-project route could never reach.
 *
 * fetch is stubbed rather than the api-client module: `mock.module` is process-wide in
 * bun, so mocking the client here would replace it for every other test file too.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { useNotificationStore } from "../../../src/web/stores/notification-store";

const realFetch = globalThis.fetch;
const realLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
let posted: { path: string; body: unknown }[] = [];
let failNext = false;

beforeEach(() => {
  posted = [];
  failNext = false;
  // The client reads an auth token from localStorage before every request; without it the
  // POST rejects before reaching fetch and the store's .catch() swallows the failure.
  // Installed per test and restored below — at module scope it leaks into every later file
  // in the same bun process.
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  } as Storage;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({
        path: new URL(String(input), "http://localhost").pathname,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (failNext) return new Response("nope", { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, data: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  useNotificationStore.setState({ notifications: new Map() });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realLocalStorage) (globalThis as { localStorage?: Storage }).localStorage = realLocalStorage;
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

/** The request is fire-and-forget, so let its promise chain drain before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("notification store clearAll", () => {
  it("marks every cleared session read in one project-agnostic request", async () => {
    const { addNotification, clearAll } = useNotificationStore.getState();
    addNotification("sess-1", "done", "alpha", "One");
    addNotification("sess-2", "done", "beta", "Two");

    clearAll();
    await settle();

    expect(useNotificationStore.getState().notifications.size).toBe(0);
    expect(posted).toHaveLength(1); // not one request per entry, per connected device
    expect(posted[0]!.path).toBe("/api/chat/sessions/read");
    expect(posted[0]!.body).toEqual({ sessionIds: ["sess-1", "sess-2"] });
  });

  it("clears a session with no project instead of skipping it", async () => {
    // This is the entry the old per-project route could not reach — /api/project//chat/…
    // matches nothing — so it was wiped locally and came straight back on reload. It is
    // also the entry most likely to exist, since it is the one PPM never recorded.
    const { addNotification, clearAll } = useNotificationStore.getState();
    addNotification("orphan", "done", "", "Unknown one");

    clearAll();
    await settle();

    expect(posted[0]!.body).toEqual({ sessionIds: ["orphan"] });
  });

  it("puts the entries back when the server refuses", async () => {
    // The server still holds them, so a reload would restore them anyway. Leaving the bell
    // empty in the meantime is the button lying about what it did.
    const { addNotification, clearAll } = useNotificationStore.getState();
    addNotification("sess-1", "done", "alpha", "One");
    failNext = true;

    clearAll();
    await settle();

    expect([...useNotificationStore.getState().notifications.keys()]).toEqual(["sess-1"]);
  });

  it("sends nothing when there is nothing to clear", async () => {
    useNotificationStore.getState().clearAll();
    await settle();
    expect(posted).toEqual([]);
  });
});
