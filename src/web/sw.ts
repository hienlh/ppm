/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

/**
 * The precache holds the app shell and nothing else.
 *
 * It used to hold everything the build emitted — 488 entries, 33.3 MB, fetched
 * on a phone's *first* visit before the app was usable. That included 18 MB of
 * Monaco language workers and Shiki grammars for languages most people never
 * open (emacs-lisp, wolfram, wasm), and it quietly undid work done elsewhere:
 * `ts.worker.bundle.js` is 12.7 MB and is never instantiated, because Monaco's
 * TypeScript service is unregistered — but the precache downloaded it anyway.
 *
 * Everything outside the shell is content-hashed and served `immutable`, so
 * `CacheFirst` is exactly right for it: fetched the first time it is genuinely
 * needed, then never fetched again. The trade is that the first *offline* visit
 * cannot open a file type whose chunk has never been loaded, which is a far
 * better bargain than 33 MB before the first paint.
 */
precacheAndRoute(self.__WB_MANIFEST);

// Every superseded precache, dropped on activate. Without this a year of
// upgrades leaves a year of shells in storage, each keyed by its own revision.
cleanupOutdatedCaches();

/**
 * An HTML response is never an asset, and caching one is what made a white
 * screen permanent.
 *
 * `static.ts` used to answer *any* missing file with the SPA shell, so a lazy
 * chunk deleted by an upgrade came back as `200 text/html`. `CacheFirst` stored
 * that under the chunk's URL in `ppm-assets`, and because content-hashed assets
 * are never revalidated, it stayed there: restoring the file on the server did
 * not fix the tab, and only `caches.delete("ppm-assets")` did.
 *
 * The server no longer sends it, which is the actual fix. This is the second
 * line of defence, and it is worth having on both sides of the cache — refusing
 * to *store* HTML protects an install that meets an old server, and refusing to
 * *serve* it heals an install that already stored some.
 */
const isHtml = (response: Response) =>
  (response.headers.get("content-type") ?? "").startsWith("text/html");

const assetIsNeverHtml = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    isHtml(response) ? null : response,
  cachedResponseWillBeUsed: async ({ cachedResponse }: { cachedResponse?: Response }) =>
    cachedResponse && isHtml(cachedResponse) ? null : cachedResponse,
};

registerRoute(
  ({ url }) => url.pathname.startsWith("/assets/"),
  new CacheFirst({ cacheName: "ppm-assets", plugins: [assetIsNeverHtml] }),
);

// Monaco's workers, which only exist once a file of that language is opened.
registerRoute(
  ({ url }) => url.pathname.startsWith("/monacoeditorwork/"),
  new CacheFirst({ cacheName: "ppm-monaco-workers", plugins: [assetIsNeverHtml] }),
);

/**
 * `registerType: "autoUpdate"` only describes what the *registration* wants; in
 * `injectManifest` mode nothing here implemented it. So a new worker installed
 * and then waited — for every tab of the origin to close, which on a machine
 * where PPM lives in a pinned tab is never. The tab kept running old JS and
 * kept asking for chunks the upgrade had already deleted.
 *
 * Taking over at once is safe precisely because assets are content-hashed: the
 * new worker's caches are keyed by different URLs, so a page mid-session cannot
 * be handed a mismatched pair.
 */
self.skipWaiting();
self.addEventListener("activate", () => {
  void self.clients.claim();
});
