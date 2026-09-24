import assert from "node:assert/strict";
import { join } from "node:path";
import { canvasLoad, canvasSelector, providerCalls, until } from "./design-mode-helpers.mjs";

/**
 * The design tab's width-adaptive layout: every width change, layout pick, pane switch,
 * expand and phone/desktop crossing must leave the canvas iframe and the chat exactly where
 * they were — the same elements, no new frame load, no new chat socket.
 *
 * The iframe and the chat's root element are tagged with an expando once; a remount would
 * hand back an untagged element, and a reload would show up as a second `ready` for the
 * nonce (or a new nonce).
 */

const ROOT = "[data-design-view]";
const CHAT_ROOT = "[data-design-chat-slot] > *";

async function tagPanes(ctx) {
  await ctx.page.evaluate(({ selector, chatRoot }) => {
    const frame = [...document.querySelectorAll(selector)].find((f) => f.closest("[data-design-view]"));
    frame.__layoutTag = "canvas";
    document.querySelector(chatRoot).__layoutTag = "chat";
  }, { selector: canvasSelector(ctx), chatRoot: CHAT_ROOT });
}

/**
 * A turn ends before its after-effects do: the canvas self-check sends a follow-up turn and
 * the files it touches reload the canvas. The baseline waits until every provider call is
 * done and the canvas has said nothing new for a while.
 */
async function settle(ctx) {
  let last = null, since = Date.now();
  await until("the design turn's after-effects to settle", async () => {
    const calls = await providerCalls(ctx);
    const readies = await ctx.page.evaluate(() => window.__e2e.bridge.filter((m) => m.type === "ready").length);
    const key = `${calls.length}:${calls.every((c) => c.done)}:${readies}`;
    if (key !== last) { last = key; since = Date.now(); return false; }
    return calls.every((c) => c.done) && Date.now() - since > 2500;
  }, { timeout: 30000, interval: 250 });
}

/** The invariant, checked after every step: same elements, one load, one socket. */
export async function assertUntouched(ctx, baseline, what) {
  const state = await ctx.page.evaluate(({ selector, nonce, sessionId, chatRoot }) => {
    const frame = [...document.querySelectorAll(selector)].find((f) => f.closest("[data-design-view]"));
    const chat = document.querySelector(chatRoot);
    return {
      frameTagged: frame?.__layoutTag === "canvas",
      chatTagged: chat?.__layoutTag === "chat",
      src: frame?.getAttribute("src"),
      readies: window.__e2e.bridge.filter((m) => m.type === "ready" && m.nonce === nonce).length,
      sockets: window.__e2e.chatSockets.filter((p) => p.endsWith(`/chat/${sessionId}`)).length,
    };
  }, { selector: canvasSelector(ctx), nonce: baseline.nonce, sessionId: ctx.sessionId, chatRoot: CHAT_ROOT });
  assert.ok(state.frameTagged, `${what}: the canvas iframe is the same element`);
  assert.ok(state.chatTagged, `${what}: the chat is the same element`);
  assert.equal(state.src, baseline.src, `${what}: the canvas src (and nonce) did not change`);
  assert.equal(state.readies, baseline.readies, `${what}: the canvas did not load again`);
  assert.equal(state.sockets, baseline.sockets, `${what}: no chat socket was opened`);
}

export async function layoutBaseline(ctx) {
  await settle(ctx);
  await tagPanes(ctx);
  const { src, nonce } = await canvasLoad(ctx);
  const counts = await ctx.page.evaluate(({ nonce, sessionId }) => ({
    readies: window.__e2e.bridge.filter((m) => m.type === "ready" && m.nonce === nonce).length,
    sockets: window.__e2e.chatSockets.filter((p) => p.endsWith(`/chat/${sessionId}`)).length,
  }), { nonce, sessionId: ctx.sessionId });
  assert.ok(counts.readies >= 1, "the canvas is loaded before the layout checks");
  assert.ok(counts.sockets >= 1, "the chat has a socket before the layout checks");
  return { src, nonce, ...counts };
}

export const layoutView = (ctx) => ctx.page.locator(ROOT).first().getAttribute("data-design-view");
const rootWidth = (ctx) => ctx.page.locator(ROOT).first().evaluate((el) => el.getBoundingClientRect().width);
const chatShare = (ctx) => ctx.page.locator(ROOT).first().evaluate((el) =>
  el.querySelector('[data-design-pane="chat"]').getBoundingClientRect().width / el.getBoundingClientRect().width);

/** Resizes the window so the design tab itself is `width` wide. */
async function setTabWidth(ctx, width, height) {
  const offset = ctx.page.viewportSize().width - await rootWidth(ctx);
  await ctx.page.setViewportSize({ width: Math.round(width + offset), height });
  await until(`the tab to be ${width}px`, async () => Math.abs(await rootWidth(ctx) - width) < 2);
}

async function pickLayout(ctx, label) {
  await ctx.page.locator('button[aria-label="Layout"]:visible').first().click();
  await ctx.page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

/** The view attribute, and what is actually painted: a hidden pane has no layout box. */
async function expectView(ctx, view, what) {
  await until(`${what}: view ${view}`, async () => (await layoutView(ctx)) === view, { timeout: 5000 });
  const shown = await ctx.page.locator(ROOT).first().evaluate((root) => {
    const boxed = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 0;
    return { canvas: boxed(root.querySelector("iframe")), chat: boxed(root.querySelector("[data-design-chat-slot]")) };
  });
  assert.deepEqual(shown, { canvas: view !== "chat", chat: view !== "canvas" }, `${what}: panes painted for ${view}`);
}

/** Desktop: thresholds with hysteresis, the layout menu, the pane toggle, expand. */
export async function stepAdaptiveLayoutDesktop(ctx) {
  const height = ctx.page.viewportSize().height;
  const baseline = await layoutBaseline(ctx);
  await expectView(ctx, "split", "a wide tab");
  const share = await chatShare(ctx);

  const widths = [[1000, "split"], [900, "split"], [850, "canvas"], [900, "canvas"], [939, "canvas"], [960, "split"], [620, "canvas"]];
  for (const [width, view] of widths) {
    await setTabWidth(ctx, width, height);
    await expectView(ctx, view, `tab ${width}px`);
    await assertUntouched(ctx, baseline, `tab ${width}px`);
  }
  ctx.record("layout follows the tab's width with hysteresis (split >= 940, single < 860)", { widths });
  await ctx.page.screenshot({ path: join(ctx.harness.artifacts, "layout-single-canvas.png") });

  // Single pane on a narrow tab: the toolbar toggle, and the chat's own header to come back.
  const paneSwitch = (name) => ctx.page.locator('[role="radiogroup"][aria-label="Design pane"]:visible').getByRole("radio", { name });
  await paneSwitch("Chat").click();
  await expectView(ctx, "chat", "toggle to chat");
  await ctx.page.locator('[data-design-pane="chat"] textarea:visible').first().waitFor();
  await ctx.page.screenshot({ path: join(ctx.harness.artifacts, "layout-single-chat.png") });
  await paneSwitch("Canvas").click();
  await expectView(ctx, "canvas", "toggle to canvas");
  await assertUntouched(ctx, baseline, "Canvas | Chat toggle");

  await pickLayout(ctx, "Split");
  await expectView(ctx, "split", "Split pinned on a 620px tab");
  const forced = await chatShare(ctx);
  assert.ok(forced >= 0.19 && forced <= 0.71, `a forced split keeps the chat's min/max share: ${forced}`);
  await setTabWidth(ctx, 1100, height);
  for (const [label, view] of [["Canvas only", "canvas"], ["Chat only", "chat"], ["Auto", "split"]]) {
    await pickLayout(ctx, label);
    await expectView(ctx, view, label);
    await assertUntouched(ctx, baseline, `layout ${label}`);
  }
  const back = await chatShare(ctx);
  assert.ok(Math.abs(back - share) < 0.03, `the split comes back at its old share: ${share} -> ${back}`);
  ctx.record("Split / Canvas only / Chat only / Auto switch by CSS alone; the split keeps its share", { share, back });

  await ctx.page.locator('button[aria-label="Expand canvas"]:visible').click();
  const box = await ctx.page.locator(`${canvasSelector(ctx)}`).first().evaluate((f) => {
    const pane = f.closest(".fixed");
    const r = pane?.getBoundingClientRect();
    return r && { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  assert.ok(box && box.x === 0 && box.y === 0 && box.w === box.vw && box.h === box.vh, `expanded covers the window: ${JSON.stringify(box)}`);
  await ctx.page.keyboard.press("Escape");
  await until("Esc to leave the full view", async () => !(await ctx.page.locator('button:has-text("Exit full view"):visible').count()));
  await ctx.page.locator('button[aria-label="Expand canvas"]:visible').click();
  await ctx.page.locator('button:has-text("Exit full view"):visible').click();
  await until("the close button to leave the full view", async () => !(await ctx.page.locator('button:has-text("Exit full view"):visible').count()));
  await assertUntouched(ctx, baseline, "expand and exit");
  ctx.record("Expand canvas covers the window; Esc and the close button exit", box);
  return baseline;
}

/**
 * Crossing the 768px breakpoint in one page. PPM's shell swaps its desktop panel layout for
 * the mobile one there and moves every tab's wrapper into the new slot, which reloads any
 * iframe in it once (the bridge's `ready` replay restores the canvas). That move is above
 * the design tab; what this checks is that nothing *inside* the tab moved — the element
 * chain from the iframe and from the chat up to the tab's root is the same — and that the
 * chat kept its socket. Returns the baseline with that one shell reload counted in.
 */
async function crossBreakpoint(ctx, baseline, viewport, what) {
  const chains = ({ selector, chatRoot, save }) => {
    const chain = (el) => { const out = []; while (el && !el.hasAttribute("data-design-view")) { out.push(el); el = el.parentElement; } return [...out, el]; };
    const frame = [...document.querySelectorAll(selector)].find((f) => f.closest("[data-design-view]"));
    const now = [chain(frame), chain(document.querySelector(chatRoot))];
    if (save) { window.__layoutChains = now; return true; }
    return now.every((c, i) => c.length === window.__layoutChains[i].length && c.every((el, j) => el === window.__layoutChains[i][j]));
  };
  const args = { selector: canvasSelector(ctx), chatRoot: CHAT_ROOT };
  await ctx.page.evaluate(chains, { ...args, save: true });
  await ctx.page.setViewportSize(viewport);
  await settle(ctx);
  assert.ok(await ctx.page.evaluate(chains, { ...args, save: false }), `${what}: nothing inside the design tab moved`);
  const readies = await ctx.page.evaluate((n) => window.__e2e.bridge.filter((m) => m.type === "ready" && m.nonce === n).length, baseline.nonce);
  assert.ok(readies <= baseline.readies + 1, `${what}: at most the shell's one reparent reload (${readies})`);
  const next = { ...baseline, readies };
  await assertUntouched(ctx, next, what);
  return next;
}

/** Crossing the phone breakpoint in the same page, then the phone's bar and expand. */
export async function stepAdaptiveLayoutPhone(ctx, first) {
  const height = ctx.page.viewportSize().height;
  const bar = ctx.page.getByRole("navigation", { name: "Design view" });
  let baseline = first;
  if (ctx.page.viewportSize().width >= 768) baseline = await crossBreakpoint(ctx, baseline, { width: 390, height: 844 }, "desktop -> phone");
  const shellReloads = [baseline.readies - first.readies];
  await bar.waitFor();
  await bar.getByRole("button", { name: "Chat" }).click();
  await expectView(ctx, "chat", "phone chat");
  await bar.getByRole("button", { name: "Canvas" }).click();
  await expectView(ctx, "canvas", "phone canvas");
  await bar.getByRole("button", { name: "More" }).click();
  await ctx.page.locator("div.rounded-t-2xl.bg-popover").getByRole("button", { name: "Expand canvas" }).click();
  const exit = ctx.page.locator('button:has-text("Exit full view"):visible');
  await exit.waitFor();
  await ctx.page.screenshot({ path: join(ctx.harness.artifacts, `layout-phone-expanded-${ctx.mobile ? "touch" : "mouse"}.png`) });
  if (await ctx.page.evaluate(() => matchMedia("(pointer: coarse)").matches)) {
    const size = await exit.boundingBox();
    assert.ok(size.height >= 44, `the close button is a 44px target on touch: ${size.height}`);
  }
  await exit.click();
  await bar.waitFor();
  await assertUntouched(ctx, baseline, "phone Canvas/Chat/More, expand and exit");
  ctx.record("phone: pane bar, More -> Expand canvas and Exit full view keep canvas and chat");
  const back = await crossBreakpoint(ctx, baseline, { width: 1366, height: Math.max(height, 844) }, "phone -> desktop");
  await expectView(ctx, "split", "phone -> desktop");
  shellReloads.push(back.readies - baseline.readies);
  ctx.record("crossing the phone breakpoint moves nothing inside the design tab and keeps the chat socket", { shellReloads });
}
