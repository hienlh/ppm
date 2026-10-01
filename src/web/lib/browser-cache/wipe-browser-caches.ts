/**
 * Wipes everything the browser cache layer holds: IndexedDB, the chat
 * preparation localStorage keys, the last-project pointer, and every
 * registered in-memory cache (the slash cache in `slash-items-cache.ts`, the
 * session store in `session-list-store.ts`).
 *
 * Called on every token drop — a 401 response or a failed login (see
 * `api-client.ts`, `login-screen.tsx`) — and never on a password change,
 * which keeps the current session's token valid.
 */
import { idbClearAll } from "./idb-keyval-cache";
import { LAST_PROJECT_REF_KEY, resetHydrationDedupe } from "./project-cache-hydration";
import { CHAT_PROVIDERS_KEY_PREFIX } from "./cache-keys";
import { CHAT_PREF_STORAGE_KEY } from "../chat-preference-local-cache";

export type CacheResetCallback = () => void;

const resetCallbacks = new Set<CacheResetCallback>();

/** Register a callback that clears an in-memory cache. Every registered
 * callback runs on every wipe. */
export function registerCacheReset(fn: CacheResetCallback): void {
  resetCallbacks.add(fn);
}

function removeCachedLocalStorageKeys(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === CHAT_PREF_STORAGE_KEY || key === LAST_PROJECT_REF_KEY || key?.startsWith(CHAT_PROVIDERS_KEY_PREFIX)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    // Storage blocked or unavailable — nothing to clear.
  }
}

/**
 * Never throws — a wipe that fails partway must not block the logout flow it
 * runs inside of.
 *
 * Everything synchronous happens before the first `await`, so it is done by
 * the time a caller that does not wait (`clearAuthToken()`, which a 401
 * follows with an immediate reload) gets control back. Only the IndexedDB
 * clear is left to finish in the background; if the page unloads first, the
 * next load's first read still sees a cache nobody can reach without a token.
 */
export async function wipeBrowserCaches(): Promise<void> {
  removeCachedLocalStorageKeys();
  resetHydrationDedupe();
  for (const fn of resetCallbacks) {
    try {
      fn();
    } catch {
      // One bad reset must not stop the others.
    }
  }
  try {
    await idbClearAll();
  } catch {
    // idbClearAll already swallows its own errors; belt and suspenders.
  }
}
