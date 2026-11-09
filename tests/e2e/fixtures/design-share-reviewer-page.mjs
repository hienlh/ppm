import assert from "node:assert/strict";

/**
 * A reviewer's browser on a design share link (`/s/<code>`), driven through the page's own
 * controls only: the Comment toggle, the design frame, the comments panel (a side panel on a
 * desktop, a bottom sheet on a phone) and its forms. Each reviewer is its own browser
 * context, so it has its own reviewer key and name, as two people would.
 */

export const INVALID_TITLE = "This link is no longer valid";

export async function openReviewer(browser, url, { mobile }) {
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
    : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  return { context, page, mobile, requests, errors };
}

const frameSelector = 'iframe[title^="Shared design:"]';

/** Where an element inside the (scaled) design frame sits on screen. */
async function frameElementCenter(rv, selector) {
  const iframe = rv.page.locator(frameSelector);
  const r = await rv.page.frameLocator(frameSelector).locator(selector).evaluate((node) => {
    const b = node.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  const f = await iframe.evaluate((node) => {
    const b = node.getBoundingClientRect();
    return { x: b.left, y: b.top, scale: b.width / node.offsetWidth };
  });
  assert.ok(r.width > 0 && r.height > 0, `${selector} is laid out in the shared design`);
  return { x: f.x + (r.x + r.width / 2) * f.scale, y: f.y + (r.y + r.height / 2) * f.scale };
}

/** The comments column: the side panel on a desktop, the bottom sheet on a phone. */
export function panel(rv) {
  return rv.mobile ? rv.page.getByRole("dialog", { name: "Comments" }) : rv.page.getByRole("complementary", { name: "Comments" });
}

export async function waitForDesign(rv, title) {
  await rv.page.getByRole("heading", { name: title }).first().waitFor({ timeout: 20000 });
  // The frame's bridge must be up before a pick can be made.
  await rv.page.frameLocator(frameSelector).locator("body").waitFor({ timeout: 20000 });
}

/**
 * Presses a form's submit button until `done` shows. A reviewer's writes are spaced at least
 * 500 ms apart, so one sent right after the last is refused with "Too many requests. Try again
 * in N s." in the page's notice; a person waits that long and presses again, and so does this.
 */
async function submit(rv, button, done) {
  const isWaitNotice = /^Too many requests\. Try again in (\d+) s\./;
  for (let waits = 0; ; waits++) {
    const before = await rv.page.evaluate(() => [...document.querySelectorAll('[role="status"]')]
      .filter((n) => /^Too many requests\./.test(n.textContent ?? "")).length);
    await button.click();
    const outcome = await Promise.race([
      done.waitFor({ timeout: 15000 }).then(() => "done"),
      rv.page.waitForFunction((n) => [...document.querySelectorAll('[role="status"]')]
        .filter((el) => /^Too many requests\./.test(el.textContent ?? "")).length > n, before, { timeout: 15000 }).then(() => "wait"),
    ]);
    if (outcome === "done") return;
    assert.ok(waits < 3, "still refused after waiting three times");
    const text = await rv.page.getByRole("status").filter({ hasText: isWaitNotice }).last().textContent();
    await rv.page.waitForTimeout(1000 * Number(isWaitNotice.exec(text.trim())[1]));
    await rv.page.getByRole("button", { name: "Dismiss" }).click().catch(() => {});
  }
}

/** Comment toggle, then the element (a phone taps it twice: the first tap only outlines it). */
export async function pinComment(rv, selector, { name, body }) {
  const { page } = rv;
  const bar = rv.mobile ? page.getByRole("navigation", { name: "Review" }) : page.locator("header");
  await bar.getByRole("button", { name: "Comment", exact: true }).click();
  const at = await frameElementCenter(rv, selector);
  if (rv.mobile) {
    await page.touchscreen.tap(at.x, at.y);
    await page.getByRole("status").filter({ hasText: "again to comment on it" }).waitFor();
    await page.touchscreen.tap(at.x, at.y);
  } else {
    await page.mouse.click(at.x, at.y);
  }
  const column = panel(rv);
  await column.getByRole("heading", { name: "New comment" }).waitFor();
  if (name) await column.getByLabel("Your name").fill(name);
  await column.getByLabel("What should change here?").fill(body);
  const form = column.locator("form").filter({ has: page.getByLabel("What should change here?") });
  // The new thread opens in the column.
  await submit(rv, form.getByRole("button", { name: "Comment" }), column.getByRole("button", { name: "All comments" }));
  await column.getByText(body).first().waitFor();
}

/** Shows the column's list, opening the phone's sheet first if it is closed. */
export async function showList(rv) {
  const column = panel(rv);
  if (rv.mobile && !(await column.isVisible())) {
    await rv.page.getByRole("navigation", { name: "Review" }).getByRole("button", { name: /^Comments \(\d+\)$/ }).click();
  }
  const back = column.getByRole("button", { name: "All comments" });
  if (await back.isVisible()) await back.click();
  await column.getByRole("list", { name: "Open comments" }).waitFor();
  return column;
}

/** Opens the thread whose comment reads `rootBody`. */
export async function openThread(rv, rootBody) {
  const column = await showList(rv);
  await column.getByRole("list", { name: "Open comments" }).getByRole("button").filter({ hasText: rootBody }).first().click();
  await column.getByRole("button", { name: "All comments" }).waitFor();
  return column;
}

export async function reply(rv, rootBody, text) {
  const column = await openThread(rv, rootBody);
  await column.getByLabel("Reply to this thread").fill(text);
  const button = column.locator("form").filter({ has: rv.page.getByLabel("Reply to this thread") }).getByRole("button", { name: "Reply" });
  await submit(rv, button, column.getByRole("list", { name: "Replies" }).getByText(text));
  return column;
}

/** Waits until the open thread shows `text` among its replies; only a poll can bring it. */
export async function waitForReply(rv, text, timeout = 25000) {
  await panel(rv).getByRole("list", { name: "Replies" }).getByText(text).waitFor({ timeout });
}

export async function waitForInvalid(rv, timeout = 25000) {
  await rv.page.getByRole("heading", { name: INVALID_TITLE }).waitFor({ timeout });
}
