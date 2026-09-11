/**
 * Recovery for the one failure that empties the screen instead of reporting an
 * error: a lazy chunk the running app asks for and cannot get.
 *
 * The chain, reproduced end to end. An upgrade replaces `dist/web` and Vite's
 * `emptyOutDir` deletes the previous content hashes, so a tab that has been open
 * across the upgrade asks for a chunk that is no longer on disk. `static.ts`
 * used to answer that with the app shell — `200 text/html` — which a module load
 * refuses on its strict MIME check; it now answers 404, but a 404 is still a
 * rejected `import()`, which is a throw inside `React.lazy`. A throw with no
 * boundary above it unmounts the whole tree: `#root` empties and the page is
 * left showing nothing but the body's background.
 *
 * The service worker made it *permanent*. `CacheFirst` on `/assets/` had stored
 * that `text/html` under the chunk's own URL, and content-hashed assets are
 * never revalidated — so restoring the file on the server changed nothing and
 * only `caches.delete("ppm-assets")` recovered the tab. `sw.ts` now refuses to
 * store or serve HTML for an asset, but an install that already holds a poisoned
 * entry has to be cleaned from the page, which is what this does before
 * reloading.
 *
 * Reloading is allowed once per tab. A second failure means the chunk is
 * genuinely unavailable, and a page that reloads itself forever is worse than
 * one that says what happened.
 */

const RELOAD_KEY = "ppm:chunk-reload";

/**
 * The wordings browsers use when a dynamic import does not produce a module.
 * Chrome, Firefox and Safari each phrase it differently, and the MIME refusal
 * is phrased differently again from a plain network failure.
 */
const CHUNK_ERROR =
  /dynamically imported module|importing a module script failed|failed to load module script|error loading chunk|expected a javascript(-or-wasm)? module script/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return CHUNK_ERROR.test(message);
}

/** Drop the caches this app owns, so the next load asks the server again. */
export async function purgeAssetCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("ppm-")).map((n) => caches.delete(n)));
  } catch {
    // A browser in private mode can refuse the Cache API outright. Reloading
    // without the purge is still the right next move.
  }
}

/** Purge and reload unconditionally — the button in the error boundary. */
export async function purgeAndReload(): Promise<void> {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Nothing to clear; the reload below is what matters.
  }
  await purgeAssetCaches();
  window.location.reload();
}

/**
 * Purge and reload at most once per tab. Returns whether a reload was started,
 * so a caller can tell "recovering" from "this is as good as it gets".
 */
export function reloadOnceForChunkError(): boolean {
  let already: boolean;
  try {
    already = sessionStorage.getItem(RELOAD_KEY) === "1";
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    // No storage means no way to count attempts, and an uncounted auto-reload
    // is an infinite loop. Leave it to the boundary's button.
    return false;
  }
  if (already) return false;
  void purgeAssetCaches().then(() => window.location.reload());
  return true;
}

export function installChunkErrorRecovery(): void {
  // Vite's preload helper dispatches this when a chunk, or one of the chunks it
  // preloads, cannot be fetched. It is deliberately *not* `preventDefault`ed:
  // cancelling the event makes the helper resolve with `undefined` rather than
  // rethrow, and `React.lazy` then fails reading `.default` of undefined — an
  // error that says nothing about what actually happened. The reload normally
  // wins the race; when it does not, the boundary catches the real throw.
  window.addEventListener("vite:preloadError", () => {
    reloadOnceForChunkError();
  });
}
