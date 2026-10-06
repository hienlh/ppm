/**
 * Does a real browser let PPM frame a forwarded page that refuses framing, and still refuse
 * every other site? Header assertions cannot answer that: the verdict is the browser's.
 *
 * A dev server answers with the framing headers frameworks send by default (Rails, Django, a
 * strict CSP, a CSP naming one partner) and with none, behind a real forward hop. Two parent
 * pages frame each of them with the attributes the web-preview tab uses: one on the origin PPM
 * registered, one on an origin it did not. A framed page reports itself to its parent from a
 * same-origin script, so a frame the browser refused reports nothing. Runs in Chromium,
 * Firefox and WebKit.
 *
 *   PPM_HOME=$(mktemp -d) PPM_PLAYWRIGHT_MODULE=<playwright/index.mjs> bun tests/e2e/forward-hop-framing-e2e.ts
 *
 * PPM_E2E_CHROMIUM_PATH, PPM_E2E_FIREFOX_PATH and PPM_E2E_WEBKIT_PATH point at a browser build
 * when the one this Playwright expects is not installed.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startForwardHop } from "../../src/services/port-forward/forward-hop.ts";
import { allowFramingFrom, forgetFramingOriginsForTest } from "../../src/services/port-forward/frame-ancestors.ts";

const PAGES: Record<string, Record<string, string>> = {
  "/open": {},
  "/rails": { "x-frame-options": "SAMEORIGIN" },
  "/django": { "x-frame-options": "DENY" },
  "/strict": { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-frame-options": "DENY" },
  "/partner": { "content-security-policy": "frame-ancestors https://partner.example" },
};

const dev = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/beacon.js") {
      return new Response("parent.postMessage(location.pathname, '*');", { headers: { "content-type": "text/javascript" } });
    }
    const headers = PAGES[pathname];
    if (!headers) return new Response("not found", { status: 404 });
    return new Response(`<!doctype html><h1>${pathname}</h1><script src="/beacon.js"></script>`, {
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });
  },
});
const hop = startForwardHop(dev.port!);
// The frames reach the hop at its own address, so that is the forward's public URL here.
const forward = `http://127.0.0.1:${hop.port}`;
hop.setPublicUrl(forward);

/** A page framing every path the way `web-preview-tab.tsx` does, collecting which ones reported in. */
const parentHtml = Object.keys(PAGES).map((path) => `<iframe name="${path}" src="${forward}${path}"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
  referrerpolicy="no-referrer"></iframe>`).join("");
const parentPage = () => new Response(`<!doctype html><script>
  window.loaded = new Set();
  addEventListener("message", (e) => window.loaded.add(e.data));
</script>${parentHtml}`, { headers: { "content-type": "text/html; charset=utf-8" } });

// Two names for the same loopback are two origins, and two sites.
const ppm = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: parentPage });
const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: parentPage });
const ppmOrigin = `http://127.0.0.1:${ppm.port}`;
const otherOrigin = `http://localhost:${other.port}`;

const modulePath = process.env.PPM_PLAYWRIGHT_MODULE;
const pw = modulePath ? await import(pathToFileURL(modulePath).href) : await import("playwright");

interface Page {
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
}

async function framedIn(page: Page, origin: string): Promise<string[]> {
  await page.goto(`${origin}/`, { waitUntil: "load" });
  // Every frame has loaded or been refused by `load`; give the beacons time to arrive.
  await page.waitForTimeout(800);
  return (await page.evaluate(() => [...(window as unknown as { loaded: Set<string> }).loaded])).sort();
}

const everything = Object.keys(PAGES).sort();
let failed = false;
try {
  for (const name of ["chromium", "firefox", "webkit"] as const) {
    const executablePath = process.env[`PPM_E2E_${name.toUpperCase()}_PATH`] || undefined;
    const browser = await pw[name].launch({ headless: true, executablePath });
    try {
      forgetFramingOriginsForTest();
      const page: Page = await browser.newPage();
      const before = await framedIn(page, ppmOrigin);
      allowFramingFrom(ppmOrigin);
      const after = await framedIn(page, ppmOrigin);
      const elsewhere = await framedIn(page, otherOrigin);
      console.log(`${name}: before ${JSON.stringify(before)} | PPM ${JSON.stringify(after)} | other site ${JSON.stringify(elsewhere)}`);
      assert.deepEqual(before, ["/open"], `${name}: every refusal holds until PPM is registered`);
      assert.deepEqual(after, everything, `${name}: PPM may frame every page`);
      assert.deepEqual(elsewhere, ["/open"], `${name}: another site is still refused`);
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  hop.stop();
  for (const server of [dev, ppm, other]) server.stop(true);
}
console.log(failed ? "FAILED" : "PASSED");
process.exit(failed ? 1 : 0);
