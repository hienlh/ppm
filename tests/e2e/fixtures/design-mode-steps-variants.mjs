import assert from "node:assert/strict";
import { join } from "node:path";
import {
  apiJson, canvasLoad, genOf, overlay, readDesign, sendDesignTurn, settleSnapshots,
  until, waitCanvasReady, writeDesign,
} from "./design-mode-helpers.mjs";
import { createDesign, openDesign } from "./design-mode-steps-canvas.mjs";

/**
 * Variants: a turn that writes three of them, and the canvas switcher. Keeping or dropping a
 * variant is done in the design chat now, not from the canvas, so that is covered by the
 * instructions/prompt unit tests rather than here. Runs on a page design of its own, so the
 * deck the other steps use keeps a single variant.
 */

const readyCount = (ctx) => ctx.page.evaluate(() => window.__e2e.bridge.filter((m) => m.type === "ready").length);

/** Opens the switcher (desktop menu, or the phone's More sheet) and returns the variant names. */
async function openSwitcher(ctx) {
  if (!ctx.mobile) {
    const trigger = ctx.page.locator('button[aria-label^="Variant: "]:visible');
    await trigger.waitFor({ timeout: 15000 });
    await trigger.click();
    return ctx.page.getByRole("menuitemradio").allTextContents();
  }
  await ctx.page.getByRole("navigation", { name: "Design view" }).getByRole("button", { name: "More" }).click();
  const group = overlay(ctx).getByRole("radiogroup", { name: "Variant" });
  await group.waitFor({ timeout: 15000 });
  return group.getByRole("radio").allTextContents();
}

/** Picks a variant in the switcher `openSwitcher` left open. */
async function chooseVariant(ctx, name) {
  if (!ctx.mobile) await ctx.page.getByRole("menuitemradio", { name }).click();
  else await overlay(ctx).getByRole("radiogroup", { name: "Variant" }).getByRole("radio", { name }).click();
}

export async function stepVariants(ctx) {
  ctx.designTitle = `Variants ${ctx.width}`;
  ctx.slug = await createDesign(ctx, ctx.designTitle, "page");
  ctx.designDir = join(ctx.harness.project, "designs", ctx.slug);
  await openDesign(ctx);
  const call = await sendDesignTurn(ctx, "Three directions for the landing page [[design:variants]]");
  assert.equal(call.step, "variants");
  const summary = (await apiJson(ctx, `/api/project/${encodeURIComponent(ctx.projectName)}/designs/${ctx.slug}`)).body.data;
  assert.deepEqual(summary.variants.map((v) => v.file), ["index.html", "variant-2.html", "variant-3.html"]);

  // Let the turn's own snapshot settle before editing, so the edit below is not raced by it.
  await settleSnapshots(ctx);
  const readies = await readyCount(ctx);
  await writeDesign(ctx, (await readDesign(ctx, "variant-3.html")).replace("One of three", "Still one of three"), "variant-3.html");
  await until("the canvas to reload after the edit", async () => (await readyCount(ctx)) > readies);
  await waitCanvasReady(ctx, genOf(await readDesign(ctx)));

  const names = await openSwitcher(ctx);
  assert.deepEqual(names.map((n) => n.trim()), ["1 · Calm", "2 · Bold", "3 · Playful"]);
  ctx.record("a turn's three variants appear in the switcher");

  const second = await readDesign(ctx, "variant-2.html");
  await chooseVariant(ctx, "2 · Bold");
  const frame = await waitCanvasReady(ctx, genOf(second));
  assert.equal(await frame.locator("#headline").textContent(), "Bold direction");
  assert.ok((await canvasLoad(ctx)).url.pathname.endsWith(`/${ctx.slug}/variant-2.html`), "the canvas loads variant-2.html");
  ctx.record("switching shows variant 2 in the canvas");
}
