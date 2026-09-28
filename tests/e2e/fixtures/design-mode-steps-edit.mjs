import assert from "node:assert/strict";
import {
  canvasSelector, changedRange, frameClick, frameElementCenter, genOf, history, lastReady, readDesign, sendDesignTurn,
  toastText, toolbar, until, waitCanvasReady, writeDesign,
} from "./design-mode-helpers.mjs";

/**
 * Canvas write-backs: tweak sliders, and Move with its stale guard, its exact undo and its
 * refusal of a commit the page forged. Every write is checked as bytes on disk.
 */

export async function stepTweaks(ctx) {
  await toolbar(ctx, "Tweaks");
  const slider = ctx.page.getByLabel("Heading size", { exact: false }).locator("visible=true").first();
  await slider.waitFor();
  const frame = await waitCanvasReady(ctx);
  await frame.evaluate(() => { window.__sameDocument = true; });
  const before = await readDesign(ctx);
  const edits = (await history(ctx)).filter((s) => s.reason === "before-edit").length;
  await slider.focus();
  for (let i = 0; i < 16; i++) await slider.press("ArrowRight");
  await until("the frame to restyle live", () => frame.evaluate(() => getComputedStyle(document.querySelector("h1")).fontSize === "80px"));
  assert.equal(await frame.evaluate(() => window.__sameDocument === true), true, "live preview did not reload the frame");
  assert.equal(await readDesign(ctx), before, "nothing is written before Apply");
  ctx.record("moving a tweak restyles the frame live, with no reload");

  await ctx.page.getByRole("button", { name: "Apply", exact: true }).locator("visible=true").click();
  const after = await until("the applied value on disk", async () => {
    const text = await readDesign(ctx);
    return text !== before && text;
  });
  const [start, endBefore, endAfter] = changedRange(before, after);
  assert.equal(before.slice(start, endBefore), "64");
  assert.equal(after.slice(start, endAfter), "80");
  assert.ok(after.includes("--heading-size: 80px;"), "written into the :root block");
  assert.equal((await history(ctx)).filter((s) => s.reason === "before-edit").length, edits + 1, "History gains before-edit");
  await waitCanvasReady(ctx, genOf(after));
  await ctx.page.locator('button[aria-label="Close tweaks"]:visible').click();
  ctx.record("Apply writes only the value into :root and snapshots before-edit");
}

async function moveOn(ctx, on) {
  const button = ctx.page.locator('button[aria-label="Move and resize"]:visible');
  if (ctx.mobile) {
    if (on) await toolbar(ctx, "Move and resize");
    else await ctx.page.locator('button[aria-label="Stop moving"]:visible').click();
    return;
  }
  if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
}

/** Move on, the card selected, and the frame reporting where it is. */
async function targetCard(ctx) {
  const lives = await ctx.page.evaluate(() => window.__e2e.bridge.filter((m) => m.type === "transform-live").length);
  await moveOn(ctx, true);
  await frameClick(ctx, "#card");
  if (ctx.mobile) await frameClick(ctx, "#card");
  await until("transform-live for the card", () => ctx.page.evaluate((n) => window.__e2e.bridge.filter((m) => m.type === "transform-live").length > n, lives));
}

async function drag(ctx, dx, midway) {
  const { x, y } = await frameElementCenter(ctx, "#card");
  const [sx, sy] = [Math.round(x), Math.round(y)];
  await ctx.page.mouse.move(sx, sy);
  await ctx.page.mouse.down();
  await ctx.page.mouse.move(sx + dx / 2, sy, { steps: 4 });
  await ctx.page.mouse.move(sx + dx, sy, { steps: 4 });
  if (midway) await midway();
  await ctx.page.mouse.up();
}

export async function stepMoveDesktop(ctx) {
  await ctx.page.getByRole("radio", { name: "Desktop" }).locator("visible=true").click();
  await targetCard(ctx);
  const before = await readDesign(ctx);
  await drag(ctx, 40);
  const after = await until("the drag on disk", async () => { const t = await readDesign(ctx); return t !== before && t; });
  const tagStart = before.indexOf('<div class="card" id="card"');
  const tagEnd = before.indexOf(">", tagStart);
  const [start, endBefore, endAfter] = changedRange(before, after);
  assert.ok(start > tagStart && endBefore <= tagEnd, "the change is inside the card's opening tag");
  assert.equal(after.slice(start, endAfter).trim(), 'style="translate: 40px 0px"');
  await waitCanvasReady(ctx, genOf(after));
  ctx.record("a 40px drag writes translate only inside the element's opening tag");

  const edited = after.replace("<h2>Highlights</h2>", "<h2>Highlights!</h2>");
  const toasts = ctx.page.locator("[data-sonner-toast]").filter({ hasText: "The design changed" });
  await drag(ctx, 20, () => writeDesign(ctx, edited));
  await toastText(ctx.page, "The design changed");
  await waitCanvasReady(ctx, genOf(edited));
  assert.equal(await readDesign(ctx), edited, "a stale drag writes nothing");
  assert.ok(await toasts.count() >= 1);
  ctx.record("a disk edit between render and release gives a 409 and no write");

  await sendDesignTurn(ctx, "Change the footer [[design:edit-footer]]");
  const aiTurn = await until("the AI edit", async () => { const t = await readDesign(ctx); return t.includes("Ask away") && t; });
  await waitCanvasReady(ctx, genOf(aiTurn));
  await toolbar(ctx, "Undo canvas edit");
  const undone = await until("the undo on disk", async () => { const t = await readDesign(ctx); return t !== aiTurn && t; });
  assert.equal(undone, aiTurn.replace(' style="translate: 40px 0px"', ""), "undo reverts only the drag");
  assert.ok(undone.includes("Questions? Ask away") && undone.includes("Highlights!"), "later edits are kept");
  await waitCanvasReady(ctx, genOf(undone));
  ctx.record("undo after a later AI turn reverts only the drag span");

  await stepForgedCommit(ctx, undone);
  await moveOn(ctx, false);
}

/** The page's own script proposes a write long after any user gesture: nothing is written. */
async function stepForgedCommit(ctx, text) {
  await targetCard(ctx);
  const ready = await lastReady(ctx);
  const posts = [];
  const onRequest = (req) => { if (req.method() === "POST" && req.url().includes("/style")) posts.push(req.url()); };
  ctx.page.on("request", onRequest);
  const frame = await waitCanvasReady(ctx);
  const ppmId = Number(await frame.locator("#card").getAttribute("data-ppm-id"));
  // Transient activation lasts about 5 s after the last gesture, and every Playwright
  // evaluate on the page or the frame counts as one. So nothing here may poll: the frame
  // reports through the console, which Playwright observes without touching either document.
  const said = (text) => ctx.page.waitForEvent("console", { predicate: (m) => m.text() === text, timeout: 20000 });
  const posted = said("e2e:forged-posted"), cancelled = said("e2e:forged-cancelled");
  await frame.evaluate(({ gen, file, ppmId }) => {
    let forged = false;
    window.addEventListener("message", (e) => { if (forged && e.data?.type === "transform-cancel") console.log("e2e:forged-cancelled"); });
    setTimeout(() => {
      forged = true;
      parent.postMessage({
        ppm: "design-bridge", v: 1, nonce: new URLSearchParams(location.search).get("n"), type: "transform-commit",
        file, gen, ppmId, tag: "div", props: { translate: "99px 0px" },
      }, "*");
      console.log("e2e:forged-posted");
    }, 7000);
  }, { gen: ready.gen, file: ready.file, ppmId });
  await posted;
  await cancelled;
  ctx.page.off("request", onRequest);
  assert.deepEqual(posts, [], "no style write was requested");
  assert.equal(await readDesign(ctx), text, "the file is unchanged");
  ctx.record("a transform-commit forged by the page without a gesture writes nothing");
}

/** Phone: the handles' hit areas, measured in screen px through the frame's scale. */
export async function stepMovePhone(ctx) {
  await targetCard(ctx);
  const frame = await waitCanvasReady(ctx);
  const scale = await ctx.page.locator(canvasSelector(ctx)).evaluate((el) => el.getBoundingClientRect().width / el.offsetWidth);
  const hit = await frame.evaluate(() => {
    const r = document.getElementById("card").getBoundingClientRect();
    const onHandle = (x, y) => document.elementFromPoint(x, y)?.localName === "ppm-design-handles";
    // Just below the bottom-right corner, outside the element's own move area. Only that
    // handle reaches past the right edge there, and it is centred on the corner, so its
    // full width is twice the stretch that is hit beyond the edge.
    const y = r.bottom + 1;
    let x = r.right;
    while (x < r.right + 1000 && onHandle(x + 0.5, y)) x += 0.5;
    return 2 * (x - r.right);
  });
  assert.ok(hit * scale >= 43, `bottom-right handle is ${(hit * scale).toFixed(1)} screen px wide`);
  await moveOn(ctx, false);
  ctx.record("phone: resize handles are at least 44 screen px", { screenPx: Math.round(hit * scale) });
}
