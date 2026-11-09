// Turn-reference e2e, part 2: the history window. A chip opens its session and lands the turn
// 16 px from the top, held while the window's images load (3); loading both ways keeps the row
// being read in place and reaching the live list merges (4); Back to latest during a stream (5);
// and a tab moved into a new panel while a landing is pinned (14).
import assert from "node:assert/strict";
import { PIN_PX } from "./session-turn-refs-helpers.mjs";

/** Click the bubble chip naming `label` in chat `sessionId`'s panel. */
export async function clickBubbleChip(ctx, project, sessionId, label) {
  const area = await ctx.kit.chatArea(ctx.page, project, sessionId);
  const chip = area.locator('[data-turn-refs] [data-turn-chip="ready"]', { hasText: label }).last();
  await chip.scrollIntoViewIfNeeded();
  await chip.locator("button").first().click();
}

/**
 * Watches the history window. A load runs from its "Loading … turns" spinner appearing to its rows
 * landing; the first visible row is taken in the frame before the load began (or, for a load too
 * quick to show a spinner, the frame before its rows landed) and measured again once they have,
 * so whatever moves it during the load — the rows, the spinner — counts. The spinner is looked for
 * anywhere in the window: "Loading earlier turns" floats over it, outside the scroller.
 */
const installLoadMonitor = (page) => page.evaluate(() => {
  const win = document.querySelector("[data-history-window]");
  const scroller = win?.querySelector(".overflow-y-auto");
  if (!scroller) throw new Error("no history window");
  window.__loads = [];
  window.__timeline = [];
  let last = null;
  let pending = null;
  const offsetOf = (id) => {
    const row = scroller.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    return row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  };
  const firstVisible = () => {
    const top = scroller.getBoundingClientRect().top;
    for (const row of scroller.querySelectorAll("[data-msg-id]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top + 1) return { id: row.getAttribute("data-msg-id"), offset: r.top - top };
    }
    return null;
  };
  const frame = () => { if (!pending) last = firstVisible(); window.__loadFrame = requestAnimationFrame(frame); };
  frame();
  const count = () => scroller.querySelectorAll("[data-msg-id]").length;
  const firstId = () => scroller.querySelector("[data-msg-id]")?.getAttribute("data-msg-id");
  const spinner = () => !!win.querySelector('[aria-busy="true"]');
  let rows = count(), head = firstId();
  new MutationObserver(() => {
    const now = count(), nowHead = firstId(), busy = spinner();
    if (busy && !pending && last) pending = { ...last };
    const anchor = pending ?? last;
    window.__timeline.push({ t: Math.round(performance.now()), rows: now, spinner: busy, scrollTop: scroller.scrollTop, row: anchor?.id?.slice(0, 8), before: anchor && Math.round(anchor.offset), now: anchor ? Math.round(offsetOf(anchor.id) ?? NaN) : null });
    if (now === rows && nowHead === head) return;
    const offset = anchor ? offsetOf(anchor.id) : null;
    window.__loads.push({ rows: [rows, now], prepended: nowHead !== head, row: anchor?.id, delta: offset === null || !anchor ? null : Math.abs(offset - anchor.offset) });
    rows = now; head = nowHead; pending = null;
    last = firstVisible();
  }).observe(win, { childList: true, subtree: true });
});

const windowScroller = (page) => page.locator("[data-history-window] .overflow-y-auto").first();

/**
 * Scrolls the window by `dy` a step at a time until `done`. Each step is an instant jump followed
 * by a pause, so a page that loads meanwhile lands while nothing else is moving the list. No step
 * is taken while a page is in flight (its spinner is up): on a slow machine a fetch outlasts the
 * pause, and a step taken then would be counted against the load it landed in.
 */
async function scrollUntil(ctx, dy, done, label, timeout = 60000) {
  const { page, kit } = ctx;
  await kit.until(label, async () => {
    if (await done()) return true;
    if (await page.locator('[data-history-window] [aria-busy="true"]').count()) return false;
    await windowScroller(page).evaluate((el, by) => { el.scrollTop += by; }, dy);
    await page.waitForTimeout(350);
    return false;
  }, timeout, 50);
}

export async function runWindowSteps(ctx) {
  const { page, kit, ids } = ctx;
  const { A, B } = ids;
  const t = (n) => A.turnIds[n - 1];

  // ── 3: a chip opens its session and lands the turn, held while the images load ──
  await kit.scenario("3", async () => {
    const clicked = Date.now();
    await clickBubbleChip(ctx, "alpha", B.id, "Turn 40");
    const landed = await kit.until("turn 40 landed in the window", async () => {
      const at = await kit.offsetOf(page, t(40));
      return at?.inWindow && Math.abs(at.offset - PIN_PX) <= 2 ? at : null;
    }, 20000, 30);
    const landingMs = Date.now() - clicked;
    const { samples, loads } = await kit.sampleOffsets(page, t(40), 3000);
    kit.assertPinned("landing over 3 s", samples);
    assert(loads >= 1, `images loaded while the landing was held (${loads})`);
    const pill = page.getByRole("button", { name: /Back to latest/ }).first();
    assert.match(await pill.innerText(), /Viewing turn \d+/);
    await kit.shot(page, "03-window-landing");
    kit.record("3: the chip opens A, the window lands turn 40 at 16±2 px and holds it for 3 s while images load", {
      landingMs, offset: landed.offset, samples: samples.length, min: Math.min(...samples), max: Math.max(...samples), imagesLoaded: loads,
    });
  });

  // ── 4: scrolling loads both ways without moving the row being read; reaching live merges ──
  await kit.scenario("4", async () => {
    // Page loads only: an image landing late moves the layout on its own (that is 4c), and one
    // landing inside a page's load would be counted against the load.
    await kit.post("/__turn-test/upload-delay", { ms: 0 });
    try {
      await installLoadMonitor(page);
      const loads = () => page.evaluate(() => window.__loads);
      await scrollUntil(ctx, -400, async () => (await loads()).filter((l) => l.prepended).length >= 2, "two older pages");
      await page.waitForTimeout(600);
      await scrollUntil(ctx, 400, async () => (await loads()).filter((l) => !l.prepended).length >= 2, "two newer pages");
      await page.waitForTimeout(600);
      const all = await loads();
      const measured = all.filter((l) => l.delta !== null);
      assert(measured.length >= 4, `loads measured: ${JSON.stringify(all)}`);
      const worst = Math.max(...measured.map((l) => l.delta));
      await kit.shot(page, "04-window-scrolled");
      const timeline = await page.evaluate(() => window.__timeline);
      assert(worst <= 2, `the row being read moved ${worst} px on a load: ${JSON.stringify(measured)}; DOM timeline: ${JSON.stringify(timeline)}`);
      kit.record("4: two older and two newer pages each moved the first visible row ≤2 px", {
        loads: measured.map((l) => ({ prepended: l.prepended, delta: Math.round(l.delta * 10) / 10 })), worst,
      });
    } finally {
      await kit.post("/__turn-test/upload-delay", { ms: 1500 });
    }
  });

  // ── 4c: images landing late above the row being read do not move it once the reader took over ──
  await kit.scenario("4c", async () => {
    await kit.post("/__turn-test/upload-delay", { ms: 2500 });
    try {
      await ctx.resetLayout(page); // a fresh page: no image is cached any more
      await clickBubbleChip(ctx, "alpha", B.id, "Turn 40");
      await kit.until("turn 40 landed", async () => (await kit.offsetOf(page, t(40)))?.inWindow, 20000, 30);
      // The reader takes over from the landing (a wheel lets go of the pin) and reads further up.
      await windowScroller(page).dispatchEvent("wheel");
      await windowScroller(page).evaluate((el) => { el.scrollTop -= 300; });
      const result = await windowScroller(page).evaluate((scroller, ms) => new Promise((done) => {
        const top = () => scroller.getBoundingClientRect().top;
        const first = [...scroller.querySelectorAll("[data-msg-id]")].find((r) => r.getBoundingClientRect().bottom > top() + 1);
        if (!first) { done({ error: "no visible row" }); return; }
        const id = first.getAttribute("data-msg-id");
        const at = () => {
          const row = scroller.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
          return row ? Math.round((row.getBoundingClientRect().top - top()) * 10) / 10 : null;
        };
        const samples = [];
        let loads = 0;
        const onLoad = (e) => { if (e.target instanceof HTMLImageElement) loads++; };
        document.addEventListener("load", onLoad, true);
        const start = performance.now();
        const tick = () => {
          // A page loading here is measured by scenario 4; frames while one is in flight are skipped.
          if (!document.querySelector('[data-history-window] [aria-busy="true"]')) {
            const offset = at();
            if (offset !== null) samples.push(offset);
          }
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else { document.removeEventListener("load", onLoad, true); done({ id, samples, loads }); }
        };
        requestAnimationFrame(tick);
      }), 4000);
      assert(!result.error, result.error);
      assert(result.loads >= 1, `images landed while the row was read (${result.loads})`);
      assert(result.samples.length > 0, "no samples");
      const spread = Math.max(...result.samples) - Math.min(...result.samples);
      assert(spread <= 2, `the row being read moved ${spread} px as images landed: ${JSON.stringify(result.samples.slice(0, 40))}`);
      await kit.shot(page, "04c-window-images-unpinned");
      kit.record("4c: images landing 2.5 s late above the row being read, after the reader took over, moved it ≤2 px", {
        samples: result.samples.length, spread, imagesLoaded: result.loads,
      });
    } finally {
      await kit.post("/__turn-test/upload-delay", { ms: 1500 });
    }
  });

  // ── 4 (second half): scrolling on from a window reaches the live list and merges ──
  await kit.scenario("4b", async () => {

    await clickBubbleChip(ctx, "alpha", B.id, "Turn 290");
    await kit.until("turn 290 landed", async () => (await kit.offsetOf(page, t(290)))?.inWindow, 20000);
    await scrollUntil(ctx, 600, async () => (await page.locator("[data-history-window]").count()) === 0, "merged into the live list", 90000);
    const liveRow = await kit.until("a window turn in the live list", async () => {
      for (const n of [300, 305, 306, 307, 308, 309, 310]) { const at = await kit.offsetOf(page, t(n)); if (at && !at.inWindow) return { n, ...at }; }
      return null;
    }, 10000);
    await kit.shot(page, "04-merged-live");
    kit.record("4b: scrolling on from turn 290 loads newer pages until the live list holds them, then merges", { mergedAt: liveRow.n });
  });

  // ── 5: Back to latest while the session streams ──
  await kit.scenario("5", async () => {
    await clickBubbleChip(ctx, "alpha", B.id, "Turn 40");
    await kit.until("window open again", async () => (await kit.offsetOf(page, t(40)))?.inWindow, 20000);
    const streamed = "Streaming reply from the live session, word by word, while the reader is in the history window, until it ends here.";
    await kit.plan(A.id, { streamMs: 6000, text: streamed });
    const run = await kit.socketTurn("alpha", A.id, "keep going on the refactor");
    await page.locator("[data-history-window] [aria-label='New activity']").waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: /Back to latest/ }).first().click();
    await kit.until("window closed", async () => (await page.locator("[data-history-window]").count()) === 0, 10000);
    await run.finished;
    const area = await kit.chatArea(page, "alpha", A.id);
    await area.locator(`text=${streamed.slice(-30)}`).waitFor({ timeout: 10000 });
    const gap = await area.locator(`text=${streamed.slice(-30)}`).evaluate((node) => {
      let el = node.parentElement;
      while (el && !(getComputedStyle(el).overflowY === "auto" && el.clientHeight > 0)) el = el.parentElement;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    assert(gap <= 4, `the live list is at the bottom (gap ${gap} px)`);
    await kit.shot(page, "05-back-to-latest-streamed");
    kit.record("5: Back to latest during a stream lands at the bottom with the streamed text there", { gap });
  });

  // ── 14: the tab moves to a new panel while a landing is pinned, and images land after ──
  await kit.scenario("14", async () => {
    await kit.post("/__turn-test/upload-delay", { ms: 2500 });
    await ctx.resetLayout(page); // a fresh page: no image is cached any more
    await clickBubbleChip(ctx, "alpha", B.id, "Turn 40");
    await kit.until("turn 40 landed", async () => {
      const at = await kit.offsetOf(page, t(40));
      return at?.inWindow && Math.abs(at.offset - PIN_PX) <= 2;
    }, 20000, 30);
    const tabEl = page.locator(`[data-tab-id="chat:claude/${A.id}"]`).first();
    const tabBox = await tabEl.boundingBox();
    const target = await page.locator('[data-panel-drop-zone="right"]').boundingBox();
    const sampling = kit.sampleOffsets(page, t(40), 4500);
    await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.92, { steps: 8 });
    await page.mouse.up();
    const { samples, loads } = await sampling;
    const layout = await kit.layoutOf(page, "alpha");
    const moved = kit.panelOf(layout, A.id);
    assert(moved && moved.id !== "left", `A moved to a new panel: ${JSON.stringify(layout.grid)}`);
    // Frames where the tab has no layout (mid-move) are skipped by the sampler; every other one counts.
    kit.assertPinned("pinned through the move and the image loads", samples);
    const after = await kit.offsetOf(page, t(40));
    assert(after?.inWindow && Math.abs(after.offset - PIN_PX) <= 2, `after the move: ${JSON.stringify(after)}`);
    await kit.shot(page, "14-split-while-pinned");
    await kit.post("/__turn-test/upload-delay", { ms: 1500 });
    kit.record("14: moving A into a new panel while turn 40 is pinned, with images landing after, keeps it at 16±2 px", {
      grid: layout.grid, samples: samples.length, min: Math.min(...samples), max: Math.max(...samples), imagesLoaded: loads,
    });
  });
}
