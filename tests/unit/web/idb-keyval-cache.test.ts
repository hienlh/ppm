/**
 * The keyval cache over IndexedDB, exercised through its in-memory fallback —
 * `bun:test` provides no `indexedDB` global, which is itself the scenario this
 * module has to survive without throwing (private browsing, storage disabled,
 * or simply no browser at all).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";
import {
  idbGet,
  idbGetEntry,
  idbSet,
  idbDelete,
  idbDeletePrefix,
  idbClearAll,
  SCHEMA_VERSION,
  __setRawEnvelopeForTest,
  __resetIdbForTest,
} from "../../../src/web/lib/browser-cache/idb-keyval-cache";

describe("idb-keyval-cache — memory fallback", () => {
  it("has no indexedDB in this test environment (the scenario under test)", () => {
    expect(typeof indexedDB).toBe("undefined");
  });

  it("round-trips a value", async () => {
    await idbSet("rt:key", { hello: "world" });
    expect(await idbGet("rt:key")).toEqual({ hello: "world" });
  });

  it("misses on a key that was never set", async () => {
    expect(await idbGet("rt:never-set")).toBeUndefined();
  });

  it("deletes a single key without touching others", async () => {
    await idbSet("del:a", 1);
    await idbSet("del:b", 2);
    await idbDelete("del:a");
    expect(await idbGet("del:a")).toBeUndefined();
    expect(await idbGet("del:b")).toBe(2);
  });

  it("treats an envelope from an older schema version as a miss", async () => {
    __setRawEnvelopeForTest("mismatch:key", { v: SCHEMA_VERSION - 1, at: Date.now(), data: "stale" });
    expect(await idbGet("mismatch:key")).toBeUndefined();
  });

  it("reads back an envelope written at the current schema version", async () => {
    __setRawEnvelopeForTest("current:key", { v: SCHEMA_VERSION, at: Date.now(), data: "fresh" });
    expect(await idbGet("current:key")).toBe("fresh");
  });

  it("deletes every key sharing a prefix, and nothing else", async () => {
    await idbSet("proj-a:slash:claude", ["/help"]);
    await idbSet("proj-a:sessions", ["s1"]);
    await idbSet("proj-b:sessions", ["s2"]);

    await idbDeletePrefix("proj-a:");

    expect(await idbGet("proj-a:slash:claude")).toBeUndefined();
    expect(await idbGet("proj-a:sessions")).toBeUndefined();
    expect(await idbGet("proj-b:sessions")).toEqual(["s2"]);
  });

  it("idbDeletePrefix is a no-op when nothing matches", async () => {
    await idbSet("keep:me", "still here");
    await idbDeletePrefix("nothing-matches:");
    expect(await idbGet("keep:me")).toBe("still here");
  });

  it("clears every key regardless of prefix", async () => {
    await idbSet("clear:a", 1);
    await idbSet("clear:b", 2);
    await idbClearAll();
    expect(await idbGet("clear:a")).toBeUndefined();
    expect(await idbGet("clear:b")).toBeUndefined();
  });

  it("overwrites a stale-version envelope on the next set, so it stops missing", async () => {
    __setRawEnvelopeForTest("upgrade:key", { v: SCHEMA_VERSION - 1, at: Date.now(), data: "old shape" });
    expect(await idbGet("upgrade:key")).toBeUndefined();
    await idbSet("upgrade:key", "new shape");
    expect(await idbGet("upgrade:key")).toBe("new shape");
  });

  it("idbGetEntry reports when a value was written", async () => {
    __setRawEnvelopeForTest("aged:key", { v: SCHEMA_VERSION, at: 1234, data: "old" });
    expect(await idbGetEntry("aged:key")).toEqual({ data: "old", at: 1234 });
    expect(await idbGetEntry("aged:never-set")).toBeUndefined();
  });
});

/**
 * The failure modes of a real browser's IndexedDB, each reproduced with a fake global.
 * The contract under test is the same for all of them: every call resolves — it never
 * rejects and never hangs — and the memory store takes over.
 */
describe("idb-keyval-cache — a hostile IndexedDB", () => {
  // Every fake goes in through `installGlobal`, so whatever the process had before —
  // nothing, today — is what the next file sees, rather than a `delete` guessing at it.
  afterEach(() => {
    uninstallDom();
    __resetIdbForTest();
  });

  /** A fake whose `open()` hands back a request the test drives by hand. */
  function fakeIndexedDb(onOpen: (req: Record<string, any>) => void): { opens: number } {
    const counter = { opens: 0 };
    installGlobal("indexedDB", {
      open: () => {
        counter.opens++;
        const req: Record<string, any> = {};
        queueMicrotask(() => onOpen(req));
        return req;
      },
    });
    return counter;
  }

  it("falls back when merely reading the indexedDB global throws", async () => {
    // Recorded first so `uninstallDom()` knows what to put back; the throwing getter a
    // plain value cannot express is then laid over it.
    installGlobal("indexedDB", undefined);
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() { throw new DOMException("The operation is insecure.", "SecurityError"); },
    });
    __resetIdbForTest();
    await idbSet("hostile:getter", 42);
    expect(await idbGet("hostile:getter")).toBe(42);
  });

  it("falls back when another tab blocks the open", async () => {
    fakeIndexedDb((req) => req.onblocked?.());
    __resetIdbForTest();
    await idbSet("hostile:blocked", "memory");
    expect(await idbGet("hostile:blocked")).toBe("memory");
  });

  it("falls back after the open timeout when the open never answers", async () => {
    fakeIndexedDb(() => { /* never fires success, error or blocked */ });
    __resetIdbForTest(20);
    const started = Date.now();
    await idbSet("hostile:silent", "memory");
    expect(await idbGet("hostile:silent")).toBe("memory");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reopens after another tab's version change closed the handle", async () => {
    const stored = new Map<string, unknown>();
    let db!: Record<string, any>;
    const counter = fakeIndexedDb((req) => {
      db = {
        closed: false,
        close() { this.closed = true; },
        transaction: () => {
          if (db.closed) throw new DOMException("The database connection is closing.", "InvalidStateError");
          const tx: Record<string, any> = {
            objectStore: () => ({
              get: (key: string) => {
                const getReq: Record<string, any> = {};
                queueMicrotask(() => { getReq.result = stored.get(key); getReq.onsuccess?.(); });
                return getReq;
              },
              put: (value: unknown, key: string) => {
                stored.set(key, value);
                queueMicrotask(() => tx.oncomplete?.());
              },
            }),
          };
          return tx;
        },
      };
      req.result = db;
      req.onsuccess?.();
    });
    __resetIdbForTest();

    await idbSet("vc:key", "first");
    expect(await idbGet("vc:key")).toBe("first");
    expect(counter.opens).toBe(1);

    db.onversionchange();
    expect(db.closed).toBe(true);
    // The dead handle is forgotten, so this reopens instead of failing silently.
    expect(await idbGet("vc:key")).toBe("first");
    expect(counter.opens).toBe(2);
  });
});
