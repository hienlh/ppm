/**
 * PPM's web browser in a real browser, against an isolated stack (scratch PPM_HOME, auth on with a
 * fixed token, a real Chrome behind the real egress guard, Vite): opened from the rail at 1440 and
 * from the phone drawer at 390, a page visited from the address bar, Vietnamese typed through IME
 * composition, and screenshots taken of both.
 *
 *   PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs PPM_PLAYWRIGHT_CHANNEL=chrome \
 *   PPM_WB_SHOTS=<dir> node tests/e2e/web-browser-e2e.mjs
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHtmlPreviewHarness } from "./fixtures/html-preview-harness.mjs";

const TOKEN = "web-browser-e2e-token";
let failures = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(200); }
  return false;
}

const harness = await createHtmlPreviewHarness({ serverScript: "tests/e2e/fixtures/web-browser-server.ts" });
const SHOTS = resolve(process.env.PPM_WB_SHOTS ?? join(harness.artifacts, "web-browser"));
await mkdir(SHOTS, { recursive: true });
const { pages } = await (await fetch(`${harness.api}/__wb-test/info`)).json();
const pageEval = async (expression) => (await (await fetch(`${harness.api}/__wb-test/eval`, { method: "POST", body: JSON.stringify({ expression }) })).json()).value;

async function newPage(viewport, mobile) {
  const ctx = await harness.browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: "vi-VN" });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("ppm-auth-token", t);
      localStorage.setItem("ppm-onboarding-v1", JSON.stringify({ version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null }));
    } catch {}
  }, TOKEN);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(harness.web, { waitUntil: "domcontentloaded" });
  // A fresh install asks about a Cloudflare domain first; answer it as a new user would.
  const notYet = page.getByRole("button", { name: "Not yet", exact: true });
  if (await until(() => notYet.isVisible(), 6000)) {
    await notYet.click();
    const close = page.getByRole("button", { name: "Close", exact: true }).last();
    if (await until(() => close.isVisible(), 3000)) await close.click();
  }
  return { ctx, page };
}

/** Heights of the browser toolbar's buttons: icon-only ones and ones with text. */
async function buttonHeights(page) {
  return page.$$eval('[role="toolbar"][aria-label="Browser"] button', (bs) => bs.filter((b) => b.offsetParent).map((b) => ({
    name: b.getAttribute("aria-label") ?? b.textContent?.trim(), text: (b.textContent ?? "").replace(/\d+/g, "").trim().length > 0 && !b.getAttribute("aria-label")?.match(/^(Tabs)$/), h: Math.round(b.getBoundingClientRect().height),
  })));
}
async function sizesMatch(page, icon, text) {
  const list = await buttonHeights(page);
  return list.length > 0 && list.every((b) => b.h === (b.text ? text : icon));
}

async function canvasHasPicture(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas[aria-label^="Page"]');
    if (!c || c.width < 100) return false;
    const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 300), 60).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90) return true; // the red header of the test page
    return false;
  });
}

try {
  // ---------------------------------------------------------------- desktop 1440
  const desk = await newPage({ width: 1440, height: 900 }, false);
  const rail = desk.page.getByRole("button", { name: "Browser", exact: true });
  check(await until(() => rail.isVisible()), "desktop: Browser button in the rail");
  await rail.click();
  const address = desk.page.getByRole("textbox", { name: "Address" });
  check(await until(() => address.isVisible()), "desktop: browser window opens with an address bar");
  check(await until(async () => (await desk.page.getByText("Starting the browser on the host…").count()) === 0, 30_000), "desktop: browser started");
  await address.click();
  await address.fill(`${pages}/news`);
  await address.press("Enter");
  check(await until(() => canvasHasPicture(desk.page), 20_000), "desktop: the page's picture arrives on the canvas");
  check(await until(async () => (await desk.page.getByRole("tab", { name: /Tin tức thử/ }).count()) > 0), "desktop: the tab shows the page title");

  // Click the page's search box through the picture, then type Vietnamese through an IME composition.
  const canvas = desk.page.locator('canvas[aria-label^="Page"]');
  const box = await canvas.boundingBox();
  await desk.page.mouse.click(box.x + 60, box.y + 75);
  await until(async () => (await pageEval("document.activeElement?.id")) === "q", 5000);
  await desk.page.evaluate(() => {
    const f = document.querySelector('textarea[aria-label="Type into the page"]');
    f.focus();
    f.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    f.dispatchEvent(new CompositionEvent("compositionupdate", { data: "thờ" }));
    f.dispatchEvent(new CompositionEvent("compositionend", { data: "thời tiết Hà Nội" }));
  });
  check(await until(async () => (await pageEval("document.getElementById('q').value")) === "thời tiết Hà Nội"), "desktop: IME text reaches the page", String(await pageEval("document.getElementById('q').value")));
  check(await sizesMatch(desk.page, 24, 28), "desktop: button heights follow design-guidelines rule 3 (icon 24px, text 28px)", JSON.stringify(await buttonHeights(desk.page)));
  await sleep(800);
  await desk.page.screenshot({ path: join(SHOTS, "desktop-1440.png") });
  // The "On host" details.
  await desk.page.getByRole("button", { name: /Runs on the host/ }).click().catch(() => desk.page.getByTitle(/Runs on the host/).click());
  await sleep(300);
  await desk.page.screenshot({ path: join(SHOTS, "desktop-1440-info.png") });
  await desk.page.keyboard.press("Escape").catch(() => {});
  check(await until(() => desk.page.evaluate(() => /RAM \d+ (MB|GB)/.test(document.body.innerText))), "desktop: status line shows the browser's RAM");
  // Settings → Web Browser.
  await desk.page.getByRole("button", { name: "Settings", exact: true }).first().click();
  const cat = desk.page.getByText("Web Browser", { exact: true }).first();
  if (await until(() => cat.isVisible(), 8000)) await cat.click();
  check(await until(() => desk.page.getByText("Let AI chats drive it").isVisible(), 8000), "desktop: Settings → Web Browser shows the switches");
  await sleep(500);
  await desk.page.screenshot({ path: join(SHOTS, "desktop-1440-settings.png") });
  await desk.ctx.close();

  // ---------------------------------------------------------------- phone 390
  const phone = await newPage({ width: 390, height: 844 }, true);
  await phone.page.getByRole("button", { name: "Open menu", exact: true }).tap();
  const tile = phone.page.getByRole("button", { name: "Browser", exact: true });
  check(await until(() => tile.isVisible()), "phone: Browser tile in the drawer");
  await tile.tap();
  const phoneAddress = phone.page.getByRole("textbox", { name: "Address" });
  check(await until(() => phoneAddress.isVisible()), "phone: browser tab opens with the address bar");
  const addrBox = await phoneAddress.boundingBox();
  check(addrBox && addrBox.y > 844 * 0.66, "phone: address bar sits in the bottom third (thumb zone)", addrBox ? `y=${Math.round(addrBox.y)}` : "");
  await phoneAddress.tap();
  await phoneAddress.fill(`${pages}/news`);
  await phoneAddress.press("Enter");
  check(await until(() => canvasHasPicture(phone.page), 20_000), "phone: the page's picture arrives");
  check(await until(async () => (await pageEval("matchMedia('(pointer: coarse)').matches && innerWidth <= 420")) === true, 10_000), "phone: the page is laid out as a phone");
  check(await sizesMatch(phone.page, 22, 26), "phone: button heights follow design-guidelines rule 3 (icon 22px, text 26px)", JSON.stringify(await buttonHeights(phone.page)));
  await sleep(800);
  await phone.page.screenshot({ path: join(SHOTS, "phone-390.png") });
  await phone.page.getByRole("toolbar", { name: "Browser" }).getByRole("button", { name: "More", exact: true }).tap();
  await sleep(400);
  await phone.page.screenshot({ path: join(SHOTS, "phone-390-menu.png") });
  await phone.ctx.close();
} catch (error) {
  failures++;
  console.log(`FAIL unexpected error — ${error?.stack ?? error}`);
} finally {
  await harness.browser.close();
  await harness.cleanup();
}
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} · screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);
