import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The built reviewer page, as `/s/<code>` serves it under `script-src 'self'; style-src
 * 'self'; worker-src 'none'; manifest-src 'none'`. Each check here is something that would
 * fail only in a browser, silently: an inline script or style the CSP blocks, a service
 * worker registration or manifest the PWA plugin injected, or an app store pulled into the
 * bundle by one careless import. Skipped until `bun run build:web` has produced the page.
 */

const webDir = resolve(import.meta.dir, "../../../dist/web");
const pagePath = resolve(webDir, "design-share-page/index.html");
const built = existsSync(pagePath);
const html = built ? readFileSync(pagePath, "utf8") : "";

// `data:` (the empty favicon) fetches nothing; everything else must be the page's own asset.
const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((r) => !r.startsWith("data:"));
const scripts = assetRefs.filter((r) => r.endsWith(".js")).map((r) => readFileSync(resolve(webDir, `.${r}`), "utf8"));

describe.skipIf(!built)("built design share page", () => {
  it("references only its own assets under /assets/share-", () => {
    expect(assetRefs.length).toBeGreaterThanOrEqual(2);
    for (const ref of assetRefs) expect(ref).toMatch(/^\/assets\/share-[A-Za-z0-9_-]+\.(?:js|css)$/);
  });

  it("has no inline script or style, which its CSP would block", () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toContain("src=");
      expect(m[2]!.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("registers no service worker and links no manifest", () => {
    expect(html).not.toContain("registerSW");
    expect(html).not.toMatch(/rel="manifest"/);
    for (const js of scripts) {
      expect(js).not.toContain("registerSW");
      expect(js).not.toContain("serviceWorker");
    }
  });

  it("carries none of the app's stores", () => {
    for (const js of scripts) {
      expect(js).not.toContain("ppm-panels-");
      expect(js).not.toContain("useTabStore");
      expect(js).not.toContain("ppm-auth");
    }
  });

  it("stays within its first-load budget of 120 KB gzip", () => {
    const total = scripts.reduce((sum, js) => sum + gzipSync(js, { level: 9 }).byteLength, 0);
    expect(total).toBeLessThanOrEqual(120 * 1024);
  });
});
