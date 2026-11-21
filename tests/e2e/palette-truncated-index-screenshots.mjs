/**
 * Screenshots of the command palette on a project the server stopped listing at its entry cap,
 * at 1440 (desktop) and 390 (phone): the "file list cut" notice, and a search that still finds a
 * shallow file although a deep folder that sorts first holds more than the cap. Runs against
 * disposable API/Vite instances from the HTML preview harness (isolated PPM_HOME, free ports),
 * never the running PPM.
 *
 *   CAP_PROJECT=<folder with more than 300k entries> SHOT_DIR=<out> \
 *   PPM_PLAYWRIGHT_MODULE=<playwright-core index.mjs> PPM_PLAYWRIGHT_CHANNEL=chrome \
 *   node tests/e2e/palette-truncated-index-screenshots.mjs
 *
 * The project needs a shallow `backend/src/tax-calculator.ts` and a deep folder that sorts before
 * it (`.tmp/…`) with more entries than the cap — the shape of the project that hit it.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

const OUT = process.env.SHOT_DIR || "/out";
const PROJECT = process.env.CAP_PROJECT;
if (!PROJECT) throw new Error("CAP_PROJECT must name a folder with more entries than the cap");
const NAME = "big";

const harness = await createHtmlPreviewHarness();
await mkdir(OUT, { recursive: true });
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? "PASS" : "FAIL"} ${what}`); };
try {
  const added = await fetch(`${harness.api}/api/projects`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: PROJECT, name: NAME }),
  });
  check(added.ok, `project registered (${added.status})`);
  // The first walk of a 300k-entry project takes a while; answer it before any browser asks.
  const started = Date.now();
  const index = await (await fetch(`${harness.api}/api/project/${NAME}/files/index?max=50000`, { signal: AbortSignal.timeout(300000) })).json();
  console.log(`index answered in ${Date.now() - started} ms: ${JSON.stringify(index.data)}`);
  check(index.data?.tooLarge === true && index.data?.truncated === true && index.data?.count === 300000, "server reports the list cut at 300,000");
  const search = await (await fetch(`${harness.api}/api/project/${NAME}/files/index/search?q=tax-calculator&kind=file&limit=5`)).json();
  check(search.data?.[0]?.path === "backend/src/tax-calculator.ts", `a shallow file past the deep folder is still found (${search.data?.[0]?.path})`);

  const devices = [
    { name: "desktop-1440", options: { viewport: { width: 1440, height: 900 } } },
    { name: "phone-390", options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ];
  for (const device of devices) {
    const context = await harness.browser.newContext(device.options);
    await context.addInitScript(({ api }) => {
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ state: { status: "dismissed" }, version: 1 }));
      // The dev bundle opens its sockets on 8081, which may be another PPM on this machine.
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(input, protocols) {
          const url = new URL(String(input), location.href);
          if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
          super(url.href, protocols);
        }
      };
    }, { api: harness.api });
    const page = await context.newPage();
    await page.goto(`${harness.web}/project/${NAME}`, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(4000);
    for (const shot of [{ name: "notice", query: "" }, { name: "search-backend", query: "tax-calculator" }]) {
      await page.evaluate((q) => window.dispatchEvent(new CustomEvent("open-command-palette", { detail: q })), shot.query);
      await page.waitForSelector("input[placeholder^='Search actions']", { timeout: 60000 });
      const notice = await page.waitForSelector("text=File list cut at 300,000 entries", { timeout: 60000 }).then(() => true, () => false);
      check(notice, `${device.name} ${shot.name}: notice shown`);
      if (shot.query) {
        const found = await page.waitForSelector("text=tax-calculator.ts", { timeout: 30000 }).then(() => true, () => false);
        check(found, `${device.name} ${shot.name}: backend file listed`);
      }
      await page.waitForTimeout(600);
      const file = join(OUT, `after-${device.name}-${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`saved ${file}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    await context.close();
  }
} finally {
  await harness.browser.close();
  await harness.cleanup();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
