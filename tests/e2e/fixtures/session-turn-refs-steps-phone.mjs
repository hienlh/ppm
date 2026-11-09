// Turn-reference e2e, part 5 (scenario 8): a phone (390×844, touch). A long press on a chip opens
// its preview sheet; a press the browser cancels for a scroll (`touchcancel`) opens nothing; a tap
// opens the session in the history window with the Back to latest pill just above the topmost bar
// under the transcript (never over the session changes bar), in the thumb zone.
import assert from "node:assert/strict";

const W = 390, H = 844;

export async function runPhoneSteps(ctx) {
  const { browser, kit, web, ids, artifacts } = ctx;
  const { A, B } = ids;
  await ctx.resetLayout(null);
  const phone = await browser.newContext({ viewport: { width: W, height: H }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, serviceWorkers: "block" });
  await phone.addInitScript(ctx.pageInit);
  const page = ctx.current = await phone.newPage();
  const cdp = await phone.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
  try {
    await page.goto(`${web}/project/alpha/chat/claude/${B.id}`);
    const chip = page.locator('[data-turn-refs] [data-turn-chip="ready"]:visible', { hasText: "Turn 40" }).first();
    await chip.waitFor({ timeout: 30000 });
    await chip.scrollIntoViewIfNeeded();
    const box = await chip.boundingBox();
    assert(box.height >= 44, `the chip is a 44px touch target (${box.height})`);
    const x = box.x + box.width / 3, y = box.y + box.height / 2;
    const sheet = page.getByRole("button", { name: "Open session" });

    // A press the browser takes for a scroll: touchstart, then touchcancel. Nothing may open.
    await touch("touchStart", x, y);
    await page.waitForTimeout(120);
    await touch("touchCancel", x, y);
    await page.waitForTimeout(800);
    assert.equal(await sheet.count(), 0, "a cancelled press opens no sheet");

    // A long press: the preview sheet, with the prompt and Open session.
    await touch("touchStart", x, y);
    await page.waitForTimeout(700);
    await touch("touchEnd", x, y);
    await sheet.waitFor({ timeout: 5000 });
    await page.locator("text=Q40: what does this screenshot show").last().waitFor();
    const open = await sheet.boundingBox();
    assert(open.height >= 44, `Open session is a 44px target (${open.height})`);
    await page.screenshot({ path: `${artifacts}/08-phone-preview-sheet.png` });
    await sheet.click();

    await kit.until("turn 40 in the window on the phone", async () => (await kit.offsetOf(page, A.turnIds[39]))?.inWindow, 30000);
    const pill = page.getByRole("button", { name: /Back to latest/ }).first();
    await pill.waitFor();
    const p = await pill.boundingBox();
    assert(p.height >= 44, `the pill is a 44px target (${p.height})`);
    assert(p.y + p.height / 2 > (H * 2) / 3, `the pill sits in the bottom third (${JSON.stringify(p)})`);
    // Over the bottom of the window, outside its scroller, and above every bar under the transcript —
    // the session changes bar included — so it covers none of them.
    assert.equal(await page.locator("[data-back-to-latest]").count(), 1, "one pill");
    assert.equal(await page.locator("[data-history-window] [data-back-to-latest]").count(), 1, "the pill is in the window");
    assert.equal(await page.locator("[data-history-window] [aria-label='Earlier turns'] [data-back-to-latest]").count(), 0, "the pill is outside the scroller");
    const below = await page.locator("[data-history-window]").evaluate((win) => {
      // The transcript area the window covers is followed by the bars and then the composer.
      const transcript = win.parentElement.closest(".flex-1.overflow-hidden") ?? win.parentElement;
      const rects = [];
      for (let el = transcript.nextElementSibling; el; el = el.nextElementSibling) {
        const r = el.getBoundingClientRect();
        if (r.height > 0) rects.push({ top: r.top, bottom: r.bottom, text: (el.textContent ?? "").slice(0, 40) });
      }
      return rects;
    });
    assert(below.length >= 2, `bars and composer found under the transcript (${JSON.stringify(below)})`);
    const topBar = Math.min(...below.map((r) => r.top));
    const gap = topBar - (p.y + p.height);
    assert(gap >= 4 && gap <= 16, `the pill sits just above the topmost bar (gap ${gap}, ${JSON.stringify(below)})`);
    assert(below.some((r) => /changed/i.test(r.text)), `the session changes bar is among the bars under the pill (${JSON.stringify(below)})`);
    await page.screenshot({ path: `${artifacts}/08-phone-window-pill.png` });
    kit.record("8: phone — a cancelled press opens nothing, a long press opens the preview sheet, and the window's Back to latest pill sits in the thumb zone", { chip: box, pill: p, gapToTopBar: gap });
  } finally {
    await phone.close();
  }
}
