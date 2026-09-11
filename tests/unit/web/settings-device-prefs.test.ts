/**
 * The two prefs that answer "what can this screen afford" are device-local.
 *
 * Every other UI pref is mirrored to the server so it survives an origin
 * change, which also means the last device to write wins everywhere. For these
 * two that is the wrong answer: a desktop turning the language server on would
 * start an 854 MB server process for a phone, and unwrapping lines on a 27-inch
 * monitor would unwrap them on a 6-inch one. So they are written to
 * localStorage only, and read back from localStorage only.
 */
import { describe, it, expect, beforeEach } from "bun:test";

interface StoreShape {
  wordWrap: boolean;
  mobileWordWrap: boolean;
  lspEnabled: boolean;
  toggleWordWrap: () => void;
  toggleMobileWordWrap: () => void;
  setLspEnabled: (enabled: boolean) => void;
  fetchServerInfo: () => Promise<void>;
}

const STORAGE_KEY = "ppm-settings";

let store: Record<string, string> = {};
let requests: { url: string; method: string; body: unknown }[] = [];
/** What `/api/settings/ui-prefs` answers with. */
let serverPrefs: Record<string, unknown> = {};

function installGlobals() {
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body =
      String(url).includes("/api/info") ? { ok: true, data: { device_name: null, version: "0.0.0" } }
      : String(url).includes("/api/settings/theme") ? { ok: true, data: { theme: null } }
      : String(url).includes("/api/settings/ui-prefs") ? { ok: true, data: serverPrefs }
      : { ok: true, data: null };
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  };
}

/** A fresh module instance, so the initial state is read from `store` as set up. */
async function loadStore(persisted?: Record<string, unknown>): Promise<() => StoreShape> {
  store = persisted ? { [STORAGE_KEY]: JSON.stringify(persisted) } : {};
  requests = [];
  installGlobals();
  const mod = await import(`../../../src/web/stores/settings-store.ts?t=${Math.random()}`);
  const use = mod.useSettingsStore as { getState: () => StoreShape };
  return () => use.getState();
}

function persisted(): Record<string, unknown> {
  return JSON.parse(store[STORAGE_KEY] ?? "{}");
}

function uiPrefPuts() {
  return requests.filter((r) => r.url.includes("/api/settings/ui-prefs") && r.method === "PUT");
}

describe("device-local settings", () => {
  beforeEach(() => { serverPrefs = {}; });

  it("starts with no language server and with wrap on for a phone", async () => {
    const get = await loadStore();
    expect(get().lspEnabled).toBe(false);
    expect(get().mobileWordWrap).toBe(true);
    // The shared pref keeps its own default, which is off.
    expect(get().wordWrap).toBe(false);
  });

  it("reads both back from localStorage", async () => {
    const get = await loadStore({ lspEnabled: true, mobileWordWrap: false });
    expect(get().lspEnabled).toBe(true);
    expect(get().mobileWordWrap).toBe(false);
  });

  it("persists them locally and sends nothing to the server", async () => {
    const get = await loadStore();
    get().setLspEnabled(true);
    get().toggleMobileWordWrap();

    expect(get().lspEnabled).toBe(true);
    expect(get().mobileWordWrap).toBe(false);
    expect(persisted().lspEnabled).toBe(true);
    expect(persisted().mobileWordWrap).toBe(false);

    // The server push is debounced, so wait past it before concluding.
    await new Promise((r) => setTimeout(r, 500));
    expect(uiPrefPuts()).toEqual([]);
  });

  it("still pushes the shared word-wrap pref, so the distinction is real", async () => {
    const get = await loadStore();
    get().toggleWordWrap();
    await new Promise((r) => setTimeout(r, 500));
    expect(uiPrefPuts().map((r) => r.body)).toEqual([{ wordWrap: true }]);
  });

  it("ignores both when the server sends them back", async () => {
    serverPrefs = { wordWrap: true, lspEnabled: true, mobileWordWrap: false };
    const get = await loadStore();
    await get().fetchServerInfo();

    // The shared pref is applied…
    expect(get().wordWrap).toBe(true);
    // …and the two device-local ones are not, whatever the server says.
    expect(get().lspEnabled).toBe(false);
    expect(get().mobileWordWrap).toBe(true);
    expect(persisted().lspEnabled).toBeUndefined();
    expect(persisted().mobileWordWrap).toBeUndefined();
  });
});
