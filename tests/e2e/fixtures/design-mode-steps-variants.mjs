import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  apiJson, canvasLoad, designFile, genOf, history, overlay, readDesign, sendDesignTurn, settleSnapshots,
  toastText, until, waitCanvasReady, writeDesign,
} from "./design-mode-helpers.mjs";
import { createDesign, openDesign } from "./design-mode-steps-canvas.mjs";

/**
 * Variants: a turn that writes three of them, the canvas switcher, and "Use this variant".
 * Runs on a page design of its own, so the deck the other steps use keeps a single variant.
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

async function useThisVariant(ctx) {
  await openSwitcher(ctx);
  if (!ctx.mobile) await ctx.page.getByRole("menuitem", { name: /^Use this variant/ }).click();
  else await overlay(ctx).getByRole("button", { name: "Use this variant", exact: true }).click();
  await overlay(ctx, "Use this variant?").getByRole("button", { name: "Use this variant", exact: true }).click();
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

  // A change after the turn's snapshot, so choosing a variant has something new to save.
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

  const picked = ctx.page.waitForResponse((r) => r.url().includes(`/designs/${ctx.slug}/variants/pick`));
  await useThisVariant(ctx);
  const res = await picked;
  assert.equal(res.status(), 200, await res.text());
  const { snapshotId } = (await res.json()).data;
  await toastText(ctx.page, /Kept 2 · Bold/);
  assert.equal(await readDesign(ctx), second, "index.html now holds variant 2");
  assert.ok(!existsSync(designFile(ctx, "variant-2.html")) && !existsSync(designFile(ctx, "variant-3.html")), "the other variant files are gone");
  assert.deepEqual(JSON.parse(await readDesign(ctx, "design.json")).variants, [{ file: "index.html", label: "Bold" }]);
  await waitCanvasReady(ctx, genOf(second));
  await until("the canvas to show index.html", async () => (await canvasLoad(ctx)).url.pathname.endsWith(`/${ctx.slug}/index.html`));
  if (!ctx.mobile) await until("the switcher to go", async () => (await ctx.page.locator('button[aria-label^="Variant: "]:visible').count()) === 0);

  const snapshot = (await history(ctx)).find((s) => s.id === snapshotId);
  assert.equal(snapshot?.reason, "pre-variant-pick", `snapshot ${snapshotId}: ${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.fileCount, 4, "the snapshot holds all three variants and the manifest");
  ctx.record("Use this variant keeps one page and saves the others to History", { snapshotId });
}
