import { describe, expect, it } from "bun:test";
import { GUEST_KEY_RE } from "../../../src/shared/design-share-guest-types";
import {
  encodeGuestKey, loadGuestKey, loadGuestName, newGuestKey, saveGuestName, storageKey, type KeyValueStore,
} from "../../../src/web/design-share-page/share-identity";

function memoryStore(seed: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

describe("design share reviewer identity", () => {
  it("makes a 43-character base64url key from 32 random bytes", () => {
    const key = newGuestKey();
    expect(key).toMatch(GUEST_KEY_RE);
    expect(newGuestKey()).not.toBe(key);
    expect(encodeGuestKey(new Uint8Array(32).fill(0xff))).toBe("_".repeat(42) + "8");
  });

  it("keeps one key per link, under that link's id, and never the code", () => {
    const store = memoryStore();
    const a = loadGuestKey(store, "aaaaaaaaaaaa");
    expect(loadGuestKey(store, "aaaaaaaaaaaa")).toBe(a);
    const b = loadGuestKey(store, "bbbbbbbbbbbb");
    expect(b).not.toBe(a);
    expect([...store.data.keys()].sort()).toEqual([storageKey("aaaaaaaaaaaa", "key"), storageKey("bbbbbbbbbbbb", "key")]);
    expect(storageKey("aaaaaaaaaaaa", "key")).toBe("ppm-share:aaaaaaaaaaaa:key");
  });

  it("replaces a malformed stored key instead of sending it", () => {
    const store = memoryStore({ [storageKey("aaaaaaaaaaaa", "key")]: "short" });
    const key = loadGuestKey(store, "aaaaaaaaaaaa", () => "k".repeat(43));
    expect(key).toBe("k".repeat(43));
    expect(store.getItem(storageKey("aaaaaaaaaaaa", "key"))).toBe("k".repeat(43));
  });

  it("saves a valid name and refuses the owner's", () => {
    const store = memoryStore();
    expect(loadGuestName(store, "aaaaaaaaaaaa")).toBeNull();
    expect(saveGuestName(store, "aaaaaaaaaaaa", "  Mai  ")).toEqual({ ok: true, name: "Mai" });
    expect(loadGuestName(store, "aaaaaaaaaaaa")).toBe("Mai");
    expect(saveGuestName(store, "aaaaaaaaaaaa", "owner").ok).toBe(false);
    expect(saveGuestName(store, "aaaaaaaaaaaa", "").ok).toBe(false);
    expect(saveGuestName(store, "aaaaaaaaaaaa", "x".repeat(41)).ok).toBe(false);
    expect(loadGuestName(store, "aaaaaaaaaaaa")).toBe("Mai");
  });

  it("does not trust a stored name the server would refuse", () => {
    const store = memoryStore({ [storageKey("aaaaaaaaaaaa", "name")]: "Owner" });
    expect(loadGuestName(store, "aaaaaaaaaaaa")).toBeNull();
  });
});
