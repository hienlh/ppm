import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Shared plumbing for the design-mode e2e: the page instrumentation, the design chat, the
 * canvas frame and its bridge traffic, and the toolbar on both layouts.
 *
 * Nothing here sleeps for a fixed time to let the app "settle". Every wait is on something
 * observable: a bridge `ready` carrying the file's gen, a provider call, a file's bytes.
 */

/** The canvas iframe of this run's design; other viewports' design tabs may be restored too. */
export const canvasSelector = (ctx) => `iframe[title="Design canvas: ${ctx.designTitle}"]`;

const BOM = String.fromCharCode(0xfeff);

/** The design source gen: 16 hex chars of SHA-256 over the BOM-less text. */
export function genOf(text) {
  return createHash("sha256").update(text.startsWith(BOM) ? text.slice(1) : text, "utf8").digest("hex").slice(0, 16);
}

export async function until(what, fn, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

export async function apiJson(ctx, path, init) {
  const res = await fetch(`${ctx.harness.api}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

export const designFile = (ctx, rel) => join(ctx.designDir, rel);
export const readDesign = (ctx, rel = "index.html") => readFile(designFile(ctx, rel), "utf8");
export const writeDesign = (ctx, text, rel = "index.html") => writeFile(designFile(ctx, rel), text);

export async function providerCalls(ctx) {
  return (await apiJson(ctx, "/__design-test/calls")).body;
}

/** The canvas iframe's current load: its src, nonce and token. */
export async function canvasLoad(ctx) {
  const src = await ctx.page.locator(canvasSelector(ctx)).getAttribute("src");
  const url = new URL(src, ctx.harness.web);
  const token = /\/content\/([0-9a-f-]{36})\//.exec(url.pathname)?.[1];
  return { src, url, nonce: url.searchParams.get("n"), token };
}

/** Waits for the frame now in the iframe to say `ready`, optionally with a given gen. */
export async function waitCanvasReady(ctx, gen = null, timeout = 15000) {
  await ctx.page.waitForFunction(({ selector, gen }) => {
    const frame = [...document.querySelectorAll(selector)].find((f) => f.offsetParent !== null) ?? document.querySelector(selector);
    if (!frame) return false;
    const nonce = new URL(frame.src, location.href).searchParams.get("n");
    return window.__e2e.bridge.some((m) => m.type === "ready" && m.nonce === nonce && (!gen || m.gen === gen));
  }, { selector: canvasSelector(ctx), gen }, { timeout });
  const handle = await ctx.page.locator(canvasSelector(ctx)).elementHandle();
  return handle.contentFrame();
}

export async function lastReady(ctx) {
  const { nonce } = await canvasLoad(ctx);
  return ctx.page.evaluate((n) => [...window.__e2e.bridge].reverse().find((m) => m.type === "ready" && m.nonce === n)?.data ?? null, nonce);
}

/** Shows the design chat (a phone switches panes) and returns its visible composer. */
export async function designComposer(ctx) {
  if (ctx.mobile) await ctx.page.getByRole("navigation", { name: "Design view" }).getByRole("button", { name: "Chat" }).click();
  const box = ctx.page.locator('textarea[placeholder="Ask anything..."]:visible, textarea[placeholder="Follow-up..."]:visible').first();
  await box.waitFor({ timeout: 15000 });
  return box;
}

export async function showCanvas(ctx) {
  if (ctx.mobile) await ctx.page.getByRole("navigation", { name: "Design view" }).getByRole("button", { name: "Canvas" }).click();
  await ctx.page.locator(`${canvasSelector(ctx)}:visible`).waitFor();
}

/** Types into the visible composer and presses its Send button. */
export async function sendFromComposer(page, text) {
  const box = page.locator('textarea[placeholder="Ask anything..."]:visible').first();
  await box.fill(text);
  await page.locator('button[aria-label="Send message"]:visible, button[aria-label="Send"]:visible').first().click();
}

/** Sends one design-chat message and waits for the scripted provider to finish the turn. */
export async function sendDesignTurn(ctx, text) {
  const before = (await providerCalls(ctx)).length;
  await designComposer(ctx);
  await sendFromComposer(ctx.page, text);
  const call = await until(`the turn for "${text}" to end`, async () => {
    const c = (await providerCalls(ctx))[before];
    return c?.done && c;
  });
  await until("the composer to be idle", async () => !(await ctx.page.locator('button[aria-label="Stop response"]:visible, button[aria-label="Stop"]:visible').count()));
  await showCanvas(ctx);
  return call;
}

/**
 * Waits for the turn snapshots to be taken on their own debounce, then for the writes under
 * way to finish, so History reflects every finished turn.
 */
export async function settleSnapshots(ctx) {
  await until("turn snapshots to settle", async () => (await apiJson(ctx, "/__design-test/pending-snapshots")).body.pending === 0);
  assert.equal((await apiJson(ctx, "/__design-test/settle-snapshots", { method: "POST" })).status, 200);
}

export async function history(ctx) {
  const res = await apiJson(ctx, `/api/project/${encodeURIComponent(ctx.projectName)}/designs/${ctx.slug}/history`);
  assert.equal(res.status, 200);
  return res.body.data;
}

/** Runs a canvas toolbar item: its bar button on desktop, its More-sheet row on a phone. */
export async function toolbar(ctx, label) {
  const { page } = ctx;
  if (!ctx.mobile) {
    await page.locator(`button[aria-label="${label}"]:visible`).first().click();
    return;
  }
  await page.getByRole("navigation", { name: "Design view" }).getByRole("button", { name: "More" }).click();
  // A row's accessible name ends with its badge count ("Comments 2") when it has one.
  const row = overlay(ctx).getByRole("button", { name: label }).filter({ hasText: label });
  await row.first().click();
}

/**
 * What a dialog renders as on this layout: a radix dialog on desktop, a bottom sheet (which
 * has no dialog role) on a phone.
 */
export function overlay(ctx, hasText) {
  const base = ctx.mobile ? ctx.page.locator("div.rounded-t-2xl.bg-popover") : ctx.page.getByRole("dialog");
  return hasText ? base.filter({ hasText }) : base;
}

/** Desktop only: the "More canvas actions" dropdown. */
export async function moreMenu(ctx, label) {
  if (ctx.mobile) return toolbar(ctx, label);
  await ctx.page.locator('button[aria-label="More canvas actions"]:visible').click();
  await ctx.page.getByRole("menuitem", { name: label }).click();
}

/**
 * Screen-space box and centre of an element inside the canvas frame, worked out from the
 * iframe's on-screen rect and its scale (the frame sits in a CSS-scaled wrapper), so a
 * pointer sent there lands on the element whatever the device frame.
 */
export async function frameElementCenter(ctx, selector) {
  const iframe = ctx.page.locator(canvasSelector(ctx));
  const el = ctx.page.frameLocator(canvasSelector(ctx)).locator(selector);
  // The canvas restores the reader's scroll on every load, so the element may be out of view.
  const r = await el.evaluate((node) => {
    node.scrollIntoView({ block: "center", inline: "nearest" });
    const b = node.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  const f = await iframe.evaluate((node) => {
    const b = node.getBoundingClientRect();
    return { x: b.left, y: b.top, scale: b.width / node.offsetWidth };
  });
  const box = { x: f.x + r.x * f.scale, y: f.y + r.y * f.scale, width: r.width * f.scale, height: r.height * f.scale };
  assert.ok(box.width > 0 && box.height > 0, `${selector} is laid out on the canvas`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box, scale: f.scale };
}

/** A click (or, on a phone, a tap) on an element inside the canvas frame. */
export async function frameClick(ctx, selector) {
  const { x, y } = await frameElementCenter(ctx, selector);
  if (ctx.mobile) await ctx.page.touchscreen.tap(x, y);
  else await ctx.page.mouse.click(x, y);
}

export async function toastText(page, pattern, timeout = 10000) {
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: pattern }).first();
  await toast.waitFor({ timeout });
  return toast.textContent();
}

/** The byte range where two texts differ, as [start, endInBefore, endInAfter]. */
export function changedRange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length, endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }
  return [start, endB, endA];
}
