/**
 * The question card shows each option's `preview` — beside the options on a wide card, below them
 * on a phone — and follows the option the user moves to. Build the fixture first:
 *   bun run vite build --config tests/e2e/fixtures/question-preview/vite.config.ts
 * then: PPM_PLAYWRIGHT_MODULE=<playwright-core>/index.mjs node tests/e2e/question-preview-e2e.mjs [screenshot dir]
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve("dist/e2e/question-preview");
const shots = process.argv[2];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname.replace(/^\/$/, "/index.html")));
  let body;
  try { body = await readFile(path); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const pw = await import(pathToFileURL(process.env.PPM_PLAYWRIGHT_MODULE).href);
const browser = await pw.chromium.launch({ headless: true, channel: process.env.PPM_PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const [name, viewport, sideBySide] of [["desktop", { width: 1100, height: 900 }, true], ["phone", { width: 390, height: 1100 }, false]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url);
    const pane = page.getByTestId("question-option-preview");
    await pane.waitFor();
    // The first option is focused when the card appears, so its plan shows without any input.
    assert.match(await pane.textContent(), /Đúng, làm luôn[\s\S]*Cài PostgreSQL 16/);

    const option = page.getByRole("button", { name: /^1\s*Đúng/ });
    const [o, p] = [await option.boundingBox(), await pane.boundingBox()];
    if (sideBySide) assert.ok(p.x >= o.x + o.width, `${name}: pane should sit right of the options`);
    else assert.ok(p.y >= o.y + o.height, `${name}: pane should sit below the options`);

    // Expand the answered card so its kept preview is in the shot too.
    await page.getByRole("button", { name: /AskUserQuestion/ }).click();
    await page.getByText("Preview · Đúng, làm luôn (Recommended)", { exact: true }).first().click();
    if (shots) await page.screenshot({ path: join(shots, `question-preview-${name}.png`), fullPage: true });

    // Moving to another option swaps the pane to that option's preview.
    await page.getByRole("button", { name: /^2\s*Cần sửa/ }).click();
    assert.match(await pane.textContent(), /Cần sửa[\s\S]*Ghi chỗ muốn đổi/);
    if (shots && name === "phone") await page.screenshot({ path: join(shots, `question-preview-${name}-option2.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  // A plan many screens tall on a real phone viewport: the pane stops at a third of the screen and
  // scrolls inside under a finger, and the buttons under it stay reachable.
  const viewport = { width: 390, height: 844 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${url}?long`);
  const pre = page.getByTestId("question-option-preview").locator("pre");
  await pre.scrollIntoViewIfNeeded();
  const box = await pre.boundingBox();
  const size = await pre.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(box.height <= viewport.height * 0.35 + 1, `pane is ${box.height}px tall on an ${viewport.height}px screen`);
  assert.ok(size.scroll > size.client * 3, `content ${size.scroll}px should overflow the ${size.client}px pane`);
  if (shots) await page.screenshot({ path: join(shots, "question-preview-phone-long-top.png") });

  // A finger drag inside the pane, as raw touch events. `Input.synthesizeScrollGesture` would read
  // better but does nothing under headless Chrome — not even the page scrolls — so it cannot fail.
  const cdp = await context.newCDPSession(page);
  const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: box.x + box.width / 2, y }] });
  await touch("touchStart", box.y + box.height - 20);
  for (let y = box.y + box.height - 30; y >= box.y + 60; y -= 10) await touch("touchMove", y);
  await touch("touchEnd");
  await page.waitForTimeout(300);
  const scrolled = await pre.evaluate((el) => el.scrollTop);
  assert.ok(scrolled > 50, `a swipe inside the pane should scroll it (scrollTop=${scrolled})`);
  if (shots) await page.screenshot({ path: join(shots, "question-preview-phone-long-scrolled.png") });

  const submit = page.getByRole("button", { name: /Submit/ });
  await submit.scrollIntoViewIfNeeded();
  const s = await submit.boundingBox();
  assert.ok(s.y >= 0 && s.y + s.height <= viewport.height + 1,
    `Submit must stay reachable under a long preview (${JSON.stringify(s)}, scrollY=${await page.evaluate(() => scrollY)}, page=${await page.evaluate(() => document.documentElement.scrollHeight)})`);
  if (shots) await page.screenshot({ path: join(shots, "question-preview-phone-long-bottom.png") });
  await context.close();

  console.log(`PASS: preview beside options on desktop, below on phone, follows the chosen option, kept on the answered card; long preview capped at ${Math.round(box.height)}px of ${viewport.height}, swipe scrolled it ${scrolled}px, Submit reachable`);
} finally {
  await browser.close();
  server.close();
}
