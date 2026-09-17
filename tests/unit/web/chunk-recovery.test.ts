/**
 * The recovery path for a missing lazy chunk, and the guard that keeps it from
 * becoming an infinite reload.
 *
 * Three things here are load-bearing and none of them are visible in review.
 * The regex decides whether the user reads "PPM has been updated" or a raw
 * browser message, and the three engines word the failure differently — the
 * strings below are the real ones, taken from a reproduction rather than
 * written from memory. The purge has to be scoped to this app's caches, because
 * the proven fix for a poisoned entry was `caches.delete("ppm-assets")` and a
 * broader sweep would take the precache with it. And the reload must happen at
 * most once per tab: a chunk that is genuinely gone would otherwise put the
 * page in a loop, which is a worse failure than the one being fixed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  isChunkLoadError,
  purgeAssetCaches,
  purgeAndReload,
  reloadOnceForChunkError,
  installChunkErrorRecovery,
} from "../../../src/web/lib/chunk-recovery.ts";

let reloads: number;
let deleted: string[];
let store: Map<string, string>;
let listeners: Map<string, () => void>;
let storageThrows: boolean;

const original = {
  window: (globalThis as Record<string, unknown>).window,
  sessionStorage: (globalThis as Record<string, unknown>).sessionStorage,
  caches: (globalThis as Record<string, unknown>).caches,
};

beforeEach(() => {
  reloads = 0;
  deleted = [];
  store = new Map();
  listeners = new Map();
  storageThrows = false;

  const g = globalThis as Record<string, unknown>;
  g.window = {
    location: { reload: () => { reloads += 1; } },
    addEventListener: (type: string, fn: () => void) => { listeners.set(type, fn); },
  };
  g.sessionStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error("storage disabled");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storageThrows) throw new Error("storage disabled");
      store.set(k, v);
    },
    removeItem: (k: string) => { store.delete(k); },
  };
  g.caches = {
    keys: async () => ["ppm-assets", "ppm-monaco-workers", "workbox-precache-v2-http://x/"],
    delete: async (name: string) => { deleted.push(name); return true; },
  };
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

describe("recognising a chunk failure", () => {
  it("matches what each engine actually says", () => {
    const real = [
      // Chrome, from the reproduction.
      new TypeError(
        "Failed to fetch dynamically imported module: http://127.0.0.1:8084/assets/settings-tab-FmY_PNER.js",
      ),
      // Chrome, when the SPA fallback answered with HTML.
      new TypeError(
        'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html". Strict MIME type checking is enforced for module scripts per HTML spec.',
      ),
      // Firefox.
      new TypeError("error loading dynamically imported module"),
      // Safari.
      new TypeError("Importing a module script failed."),
    ];
    for (const error of real) expect(isChunkLoadError(error), error.message).toBe(true);
  });

  it("does not claim an ordinary render error", () => {
    // Everything else has to reach the boundary's generic branch, message and
    // all — labelling a null dereference "PPM has been updated" would send the
    // user to reload forever over a real bug.
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new Error("Maximum update depth exceeded"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("reads a thrown non-Error too", () => {
    expect(isChunkLoadError("Failed to fetch dynamically imported module: /assets/x.js")).toBe(true);
  });
});

describe("purging", () => {
  it("deletes this app's caches and leaves the precache alone", async () => {
    // `ppm-assets` is the one that held the poisoned entry; the precache is
    // managed by workbox and refills itself, so sweeping it is needless churn.
    await purgeAssetCaches();
    expect(deleted).toEqual(["ppm-assets", "ppm-monaco-workers"]);
  });

  it("still reloads when the Cache API is unavailable", async () => {
    // A private-mode browser can refuse it outright.
    (globalThis as Record<string, unknown>).caches = {
      keys: async () => { throw new Error("denied"); },
    };
    await purgeAndReload();
    expect(reloads).toBe(1);
  });
});

describe("reloading at most once per tab", () => {
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  it("reloads the first time and never again", async () => {
    expect(reloadOnceForChunkError()).toBe(true);
    await settle();
    expect(reloads).toBe(1);
    expect(deleted).toEqual(["ppm-assets", "ppm-monaco-workers"]);

    // Second failure in the same tab: the chunk is really not there, so leave
    // the boundary to say so rather than spin.
    expect(reloadOnceForChunkError()).toBe(false);
    await settle();
    expect(reloads).toBe(1);
  });

  it("does not auto-reload when it cannot count attempts", async () => {
    // Safari in private mode throws on write. Without a counter an auto-reload
    // is an unbounded loop, so it must not happen at all — the button still works.
    storageThrows = true;
    expect(reloadOnceForChunkError()).toBe(false);
    await settle();
    expect(reloads).toBe(0);
  });

  it("lets the explicit button through even after the automatic attempt", async () => {
    reloadOnceForChunkError();
    await settle();
    await purgeAndReload();
    expect(reloads).toBe(2);
  });

  it("hooks vite:preloadError", async () => {
    installChunkErrorRecovery();
    const handler = listeners.get("vite:preloadError");
    expect(handler).toBeDefined();
    handler!();
    await settle();
    expect(reloads).toBe(1);
  });
});
