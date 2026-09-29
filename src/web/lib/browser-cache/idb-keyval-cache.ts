/**
 * Minimal key/value cache over IndexedDB, with an in-memory `Map` fallback
 * for whenever IndexedDB is missing (module scope under `bun:test`, private
 * browsing, storage disabled) or a call to it fails.
 *
 * One database (`ppm-cache`), one store (`kv`), a **fixed** version — this
 * cache never needs a schema migration, because every value is wrapped in an
 * envelope carrying its own `SCHEMA_VERSION`. An envelope written by an older
 * build simply reads back as a miss and gets overwritten on the next write;
 * the database itself is never deleted or reopened at a new version.
 *
 * Every export here is async and never throws — a caller that cannot read or
 * write this cache should silently fall through to a network fetch, not
 * break the feature it is speeding up.
 */

const DB_NAME = "ppm-cache";
const STORE_NAME = "kv";
const DB_VERSION = 1;

/** Bump this when a cached value's shape changes. Older envelopes are then
 * misses rather than being read (and possibly mis-parsed) as the new shape. */
export const SCHEMA_VERSION = 1;

interface Envelope<T> {
  v: number;
  at: number;
  data: T;
}

/** Backing store used whenever IndexedDB is unavailable. Also the only store
 * a `bun:test` process ever reaches, since no test runtime provides `indexedDB`. */
const memoryStore = new Map<string, Envelope<unknown>>();

/** How long an open may stay unanswered before this page gives up on
 * IndexedDB and uses the memory store instead. An open that another tab
 * blocks, or that a broken profile never settles, would otherwise hang every
 * caller that awaits it — including the session list's first sync. */
const OPEN_TIMEOUT_MS = 1500;
let openTimeoutMs = OPEN_TIMEOUT_MS;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Opens (once) and memoizes the database handle. Resolves `null` — never
 * rejects, never hangs past `openTimeoutMs` — on any failure, so every
 * operation below can treat "no IndexedDB" and "IndexedDB open failed" the
 * same way: fall back to `memoryStore`.
 *
 * Even reading the `indexedDB` global sits inside the `try`: in a sandboxed or
 * cookie-blocked context it is a getter that throws `SecurityError`, and a
 * throw from the executor would reject — and memoize — the promise. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const attempt = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        // Answered after the timeout already fell back — nobody holds this handle.
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), openTimeoutMs);
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) {
        finish(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) {
            req.result.createObjectStore(STORE_NAME);
          }
        } catch {
          finish(null);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // A closed handle fails every later transaction, so forget it: the
        // next call reopens (or falls back) instead of reusing a dead one.
        const forget = () => { if (dbPromise === attempt) dbPromise = null; };
        // Another tab upgraded (or deleted) the database — release it so that
        // tab is not blocked, then let the next call reopen.
        db.onversionchange = () => { db.close(); forget(); };
        db.onclose = forget;
        finish(db);
      };
      req.onerror = () => finish(null);
      // Another tab holds the database open at an older version and will not
      // let go; waiting on it would hang this page's first read indefinitely.
      req.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
  dbPromise = attempt;
  return attempt;
}

/**
 * Forgets the memoized handle so the next call reopens, optionally with a
 * shorter open timeout. Tests only: each test installs its own fake
 * `indexedDB` and needs this module to look at it afresh.
 */
export function __resetIdbForTest(timeoutMs: number = OPEN_TIMEOUT_MS): void {
  dbPromise = null;
  openTimeoutMs = timeoutMs;
  memoryStore.clear();
}

/** A cached value together with when it was written (epoch ms). */
export interface IdbEntry<T> {
  data: T;
  at: number;
}

function readEnvelope<T>(env: Envelope<T> | undefined): IdbEntry<T> | undefined {
  if (!env || env.v !== SCHEMA_VERSION) return undefined;
  return { data: env.data, at: typeof env.at === "number" ? env.at : 0 };
}

/** Like `idbGet`, but also says how old the value is — for a caller that shows
 * cached data immediately yet must still know whether to refresh it. */
export async function idbGetEntry<T>(key: string): Promise<IdbEntry<T> | undefined> {
  const db = await openDb();
  if (!db) return readEnvelope(memoryStore.get(key) as Envelope<T> | undefined);
  try {
    const env = await new Promise<Envelope<T> | undefined>((resolve) => {
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result as Envelope<T> | undefined);
      req.onerror = () => resolve(undefined);
    });
    return readEnvelope(env);
  } catch {
    return undefined;
  }
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  return (await idbGetEntry<T>(key))?.data;
}

export async function idbSet<T>(key: string, data: T): Promise<void> {
  const envelope: Envelope<T> = { v: SCHEMA_VERSION, at: Date.now(), data };
  const db = await openDb();
  if (!db) {
    memoryStore.set(key, envelope as Envelope<unknown>);
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(envelope, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // A write we cannot make durable is not worth surfacing — the next read
    // just misses and falls back to a fresh fetch.
  }
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memoryStore.delete(key);
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  }
}

/** Deletes every key that starts with `prefix` — how a project's cache
 * entries (all sharing its `projectCacheId` prefix) are evicted together on
 * rename/delete/wipe, without the caller enumerating individual keys. */
export async function idbDeletePrefix(prefix: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    for (const key of [...memoryStore.keys()]) {
      if (key.startsWith(prefix)) memoryStore.delete(key);
    }
    return;
  }
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      // String keys sort by UTF-16 code unit in IndexedDB, same as JS — so a
      // range bounded by the prefix and the prefix plus the highest BMP code
      // unit covers exactly the keys that start with it.
      const range = IDBKeyRange.bound(prefix, prefix + "￿");
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      req.onerror = () => resolve();
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  }
}

export async function idbClearAll(): Promise<void> {
  memoryStore.clear();
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  }
}

/**
 * Writes an envelope directly into the fallback store, bypassing
 * `SCHEMA_VERSION` — the only way to reproduce "an older build's envelope"
 * in a test, since two fresh module imports do not share `memoryStore`.
 * Exported for tests only; production code always goes through `idbSet`.
 */
export function __setRawEnvelopeForTest(key: string, envelope: { v: number; at: number; data: unknown }): void {
  memoryStore.set(key, envelope);
}
