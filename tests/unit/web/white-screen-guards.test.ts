/**
 * The invariants that together are the difference between a white screen and a
 * message with a button.
 *
 * There are *two* ways this app can go blank, and they need different guards.
 * A lazy chunk that will not load throws inside `React.lazy`, and a throw past
 * the last boundary makes React unmount the whole tree — that one the root
 * boundary catches. But the entry's own module graph is ~39 separately-hashed
 * chunks, and if any one of them 404s the entry module never executes at all:
 * no React, no boundary, no listener, `#root` empty. Nothing bundled can report
 * that, because nothing bundled ran, which is why there is an inline watchdog in
 * `index.html` as well — and why the two must not both fire on the same page.
 *
 * None of it can be asserted by rendering: a nested boundary is not a root one,
 * the service worker lines only matter in a real worker, and the watchdog only
 * matters when the bundle is absent. What a refactor can silently do is drop
 * them — `<App />` re-nested one level up, a plugin dropped while renaming a
 * cache, a flag renamed on one side — so they are pinned as source shape, which
 * is the only place the information exists.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(import.meta.dir, "../../../", p), "utf8");

describe("the root error boundary is actually at the root", () => {
  const main = read("src/web/main.tsx");

  it("wraps App, so an uncaught throw cannot empty #root", () => {
    expect(main).toMatch(/<RootErrorBoundary>\s*<App \/>\s*<\/RootErrorBoundary>/);
  });

  it("installs the chunk listener before the first render", () => {
    // Vite's preload helper dispatches on `window`, so the listener has to
    // exist before anything can import a chunk — including during mount.
    const install = main.indexOf("installChunkErrorRecovery()");
    const render = main.indexOf("createRoot(");
    expect(install).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(install);
  });
});

describe("the service worker cannot keep a white screen alive", () => {
  const sw = read("src/web/sw.ts");

  it("guards both runtime caches against storing or serving HTML", () => {
    // `CacheFirst` stored the SPA fallback's `text/html` under a chunk's URL,
    // and because assets are never revalidated it stayed: restoring the file on
    // the server did not fix the tab, only deleting the cache did.
    const routes = sw.match(/new CacheFirst\(\{[^}]*\}\)/g) ?? [];
    expect(routes.length).toBe(2);
    for (const route of routes) expect(route).toContain("plugins: [assetIsNeverHtml]");
    expect(sw).toContain("cacheWillUpdate");
    expect(sw).toContain("cachedResponseWillBeUsed");
  });

  it("takes over instead of waiting for every tab to close", () => {
    // `registerType: "autoUpdate"` describes what the registration wants; in
    // `injectManifest` mode nothing implemented it, so a new worker waited —
    // on a pinned tab, forever — while the page kept asking for deleted chunks.
    expect(sw).toContain("self.skipWaiting()");
    expect(sw).toContain("self.clients.claim()");
    expect(sw).toContain("cleanupOutdatedCaches()");
  });
});

describe("the inline watchdog covers what React cannot", () => {
  const html = read("src/web/index.html");
  const main = read("src/web/main.tsx");

  it("is inline, because a missing chunk is exactly what it reports", () => {
    // A watchdog in a module cannot run when the module graph is what failed.
    expect(html).toContain("ppm:boot-retry");
    expect(html).toContain("ppm-boot-retry");
    expect(html).not.toMatch(/<script[^>]+src=[^>]*watchdog/);
  });

  it("agrees with main.tsx on the flag that stands down the watchdog", () => {
    // The two halves live in different files and different languages. A rename
    // on one side leaves the watchdog firing over a perfectly healthy app and
    // replacing its DOM, which is worse than the bug it exists for.
    expect(html).toContain("window.__ppmEntryRan");
    expect(main).toContain("__ppmEntryRan = true");
    const flag = main.indexOf("__ppmEntryRan");
    const render = main.indexOf("createRoot(");
    expect(flag).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(flag);
  });

  it("offers a way out that survives having no storage", () => {
    // No sessionStorage means no way to count attempts, and an uncounted
    // auto-reload is a loop — so that path must go straight to the message.
    expect(html).toMatch(/catch \(e\) \{[\s\S]{0,400}retried = true/);
  });
});
