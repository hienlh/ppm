/**
 * The wipe wiring: a dropped token clears every browser cache, and it is
 * reached from exactly the two places a token is actually dropped — the 401
 * handler and `clearAuthToken()` itself (which `login-screen.tsx` calls on a
 * failed login). A password change never goes through either path, so it
 * must leave the cache alone.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();

// Put back afterwards: every file in this process shares these globals, and a bare
// `window` object left behind has no `addEventListener` for the next file's modules.
const savedGlobals = {
  localStorage: (globalThis as any).localStorage,
  sessionStorage: (globalThis as any).sessionStorage,
  window: (globalThis as any).window,
};
afterAll(() => {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete (globalThis as any)[key];
    else (globalThis as any)[key] = value;
  }
});

(globalThis as any).localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  get length() { return localStore.size; },
  key: (i: number) => [...localStore.keys()][i] ?? null,
};
(globalThis as any).sessionStorage = {
  getItem: (k: string) => sessionStore.get(k) ?? null,
  setItem: (k: string, v: string) => void sessionStore.set(k, v),
  removeItem: (k: string) => void sessionStore.delete(k),
};
// The 401 path reloads the page; nothing here needs a real navigation.
(globalThis as any).window = { location: { reload: () => {} } };

const { api, setAuthToken, clearAuthToken, getAuthToken } = await import("../../../src/web/lib/api-client");
const { idbSet, idbGet } = await import("../../../src/web/lib/browser-cache/idb-keyval-cache");
const { writeChatPreparationSettings, readChatPreparationSettings } =
  await import("../../../src/web/lib/chat-preference-local-cache");
const { registerCacheReset, wipeBrowserCaches } = await import("../../../src/web/lib/browser-cache/wipe-browser-caches");

const realFetch = globalThis.fetch;

/** `clearAuthToken()` fires `wipeBrowserCaches()` without awaiting it, and
 * that promise chains through several `await`s of its own (open the — absent
 * — IndexedDB, clear it, …). A macrotask flush drains all of them, where a
 * fixed number of `Promise.resolve()` hops would be guessing at the depth. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function stub401() {
  (globalThis as any).fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

/** Seeds every layer the wipe has to reach, so a test can assert all of them
 * emptied out together rather than trusting one proxy signal. */
async function seedCaches(): Promise<void> {
  setAuthToken("secret-token");
  await idbSet("seed:key", "seed-value");
  writeChatPreparationSettings({ default_provider: "claude", providers: {} });
}

beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
});

describe("wipe wiring — token drop", () => {
  it("clearAuthToken() drops the token and wipes every cache", async () => {
    await seedCaches();

    let resetRan = false;
    registerCacheReset(() => { resetRan = true; });

    clearAuthToken();
    await flushMicrotasks();

    expect(getAuthToken()).toBeNull();
    expect(await idbGet("seed:key")).toBeUndefined();
    expect(readChatPreparationSettings()).toBeNull();
    expect(resetRan).toBe(true);
  });

  it("a 401 response goes through the same clearAuthToken() wipe", async () => {
    await seedCaches();
    stub401();

    await expect(api.get("/api/anything")).rejects.toThrow("Unauthorized");
    await flushMicrotasks();

    expect(getAuthToken()).toBeNull();
    expect(await idbGet("seed:key")).toBeUndefined();
    expect(readChatPreparationSettings()).toBeNull();

    (globalThis as any).fetch = realFetch;
  });
});

describe("wipe order", () => {
  it("clears localStorage and runs the in-memory resets before it awaits IndexedDB", async () => {
    await seedCaches();
    localStorage.setItem("ppm-last-project-ref", JSON.stringify({ name: "p", path: "/abs/p" }));
    localStorage.setItem("ppm-chat-providers:abc", "[]");
    let resetRan = false;
    registerCacheReset(() => { resetRan = true; });

    // A 401 reloads the page right after this call returns, without awaiting it —
    // so everything that can be done synchronously must already be done here.
    const pending = wipeBrowserCaches();
    expect(readChatPreparationSettings()).toBeNull();
    expect(localStorage.getItem("ppm-chat-providers:abc")).toBeNull();
    expect(localStorage.getItem("ppm-last-project-ref")).toBeNull();
    expect(resetRan).toBe(true);

    await pending;
    expect(await idbGet("seed:key")).toBeUndefined();
  });

  it("leaves unrelated localStorage keys alone", async () => {
    localStorage.setItem("ppm-theme", "dark");
    await wipeBrowserCaches();
    expect(localStorage.getItem("ppm-theme")).toBe("dark");
  });
});

describe("wipe wiring — password change", () => {
  it("setAuthToken() alone (what a password change does) does not wipe the cache", async () => {
    await seedCaches();

    // A password change re-issues the token for the same session without
    // ever calling clearAuthToken — see change-password-section.tsx.
    setAuthToken("new-token-after-password-change");

    expect(getAuthToken()).toBe("new-token-after-password-change");
    expect(await idbGet("seed:key")).toBe("seed-value");
    expect(readChatPreparationSettings()).not.toBeNull();
  });
});
