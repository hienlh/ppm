import { GUEST_KEY_RE } from "../../shared/design-share-guest-types";
import { parseGuestName } from "../../shared/design-comment-thread-types";

/**
 * Who this browser is on one share link: a random key that makes entries "mine", and the
 * name the reviewer typed. Both live in this origin's storage under `ppm-share:<linkId>:*`,
 * keyed by the link's opaque id rather than its code, so the code is never written to
 * storage and two links never share an identity.
 *
 * The key comes from `crypto.getRandomValues`, which exists on a plain-HTTP origin;
 * `crypto.subtle` and `randomUUID` do not, and a LAN address is how a phone often arrives.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type IdentityField = "key" | "name";

export function storageKey(linkId: string, field: IdentityField): string {
  return `ppm-share:${linkId}:${field}`;
}

/** Bytes as unpadded base64url; 32 bytes give the 43 characters the server expects. */
export function encodeGuestKey(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newGuestKey(fill: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return encodeGuestKey(fill(new Uint8Array(32)));
}

/** The stored key, or a new one saved in its place when there is none or it is malformed. */
export function loadGuestKey(store: KeyValueStore, linkId: string, make: () => string = newGuestKey): string {
  const stored = store.getItem(storageKey(linkId, "key"));
  if (stored && GUEST_KEY_RE.test(stored)) return stored;
  const key = make();
  store.setItem(storageKey(linkId, "key"), key);
  return key;
}

/** The stored name if it would still be accepted, else null (the page asks again). */
export function loadGuestName(store: KeyValueStore, linkId: string): string | null {
  const parsed = parseGuestName(store.getItem(storageKey(linkId, "name")));
  return parsed.ok ? parsed.name : null;
}

export function saveGuestName(
  store: KeyValueStore, linkId: string, raw: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const parsed = parseGuestName(raw);
  if (parsed.ok) store.setItem(storageKey(linkId, "name"), parsed.name);
  return parsed;
}

/**
 * `localStorage`, or memory when it cannot be used (a private window can throw on every
 * access). An identity held in memory only lasts the visit, which is still a working page.
 */
export function browserStore(): KeyValueStore {
  const memory = new Map<string, string>();
  const fallback: KeyValueStore = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => { memory.set(k, v); },
  };
  try {
    const ls = window.localStorage;
    const probe = "ppm-share:probe";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return {
      getItem: (k) => { try { return ls.getItem(k); } catch { return fallback.getItem(k); } },
      setItem: (k, v) => { try { ls.setItem(k, v); } catch { fallback.setItem(k, v); } },
    };
  } catch {
    return fallback;
  }
}
