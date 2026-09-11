/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
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

registerRoute(
  ({ url }) => url.pathname.startsWith("/assets/"),
  new CacheFirst({ cacheName: "ppm-assets" }),
);

// Monaco's workers, which only exist once a file of that language is opened.
registerRoute(
  ({ url }) => url.pathname.startsWith("/monacoeditorwork/"),
  new CacheFirst({ cacheName: "ppm-monaco-workers" }),
);
