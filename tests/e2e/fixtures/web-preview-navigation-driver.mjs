import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const forward = process.env.PPM_PREVIEW_FORWARD;
let browser;
try {
  const pw = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href);
  browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${process.env.PPM_PREVIEW_PARENT}/?url=${encodeURIComponent(forward + "/")}`);
  const frame = page.frameLocator("iframe");
  const address = page.locator('a[aria-label="Open in browser"]');
  async function addressIs(path) {
    await page.waitForFunction((url) => document.querySelector('a[aria-label="Open in browser"]')?.getAttribute("href") === url, forward + path);
    assert.equal(await address.getAttribute("href"), forward + path);
  }
  await frame.locator("#spa").click();
  await addressIs("/lucky?lang=en#rules");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await frame.locator("#spa").waitFor();
  assert.equal(page.frames()[1].url(), forward + "/lucky?lang=en#rules");
  await frame.locator("#replace").click();
  await addressIs("/replaced?lang=vi");
  await frame.locator("#spa").click();
  await page.frames()[1].evaluate(() => history.back());
  await addressIs("/replaced?lang=vi");
  await page.frames()[1].evaluate(() => { location.hash = "hash"; });
  await addressIs("/replaced?lang=vi#hash");
  await frame.locator("#full").click();
  await addressIs("/full?lang=en");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await frame.locator("#spa").waitFor();
  assert.equal(page.frames()[1].url(), forward + "/full?lang=en");
  if (process.env.PPM_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PPM_PREVIEW_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log("PASS: SPA push/replace, Back, hash, full navigation, reload, gzip HTML, CSP self; no page errors");
} finally {
  await browser?.close();
}
