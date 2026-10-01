/**
 * The wipe wiring: a dropped token clears every browser cache, and it is
 * reached from exactly the two places a token is actually dropped — the 401
 * handler and `clearAuthToken()` itself (which `login-screen.tsx` calls on a
 * failed login). A password change never goes through either path, so it
 * must leave the cache alone.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();

// Through `installGlobal` so the process-wide DOM's own storage and `fetch` come back
// afterwards. `window` itself is the real one: a bare object standing in for it would be
// what any module first imported here bound its listeners to, for the rest of the run.
afterAll(uninstallDom);
installGlobal("localStorage", {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  get length() { return localStore.size; },
  key: (i: number) => [...localStore.keys()][i] ?? null,
});
installGlobal("sessionStorage", {
  getItem: (k: string) => sessionStore.get(k) ?? null,
  setItem: (k: string, v: string) => void sessionStore.set(k, v),
  removeItem: (k: string) => void sessionStore.delete(k),
});

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
  installGlobal("fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ));
}

/** Seeds every layer the wipe has to reach, so a test can assert all of them
 * emptied out together rather than trusting one proxy signal. */
async function seedCaches(): Promise<void> {
  setAuthToken("secret-token");
  await idbSet("seed:key", "seed-value");
  writeChatPreparationSettings({ default_provider: "claude", providers: {} });
}

// The 401 path reloads the page; nothing here needs a real navigation, and the DOM this
// process shares must not be navigated away under the files that run after this one.
let reload: ReturnType<typeof spyOn>;
beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
  reload = spyOn(window.location, "reload").mockImplementation(() => {});
});
afterEach(() => {
  reload.mockRestore();
  installGlobal("fetch", realFetch);
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
    expect(reload).toHaveBeenCalledTimes(1);
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
