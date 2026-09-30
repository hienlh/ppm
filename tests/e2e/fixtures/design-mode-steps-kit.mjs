import assert from "node:assert/strict";
import { join } from "node:path";
import { writeDesign } from "./design-mode-helpers.mjs";
import { createDesign, openDesign } from "./design-mode-steps-canvas.mjs";

/**
 * The shared UI kit (`designs/kit/`, written once at harness start-up): a design that links
 * `../kit/app.css` and a `../kit/icons/*.svg` renders with the kit's real, compiled styles and
 * artwork, not just its own inline CSS.
 */

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="../kit/app.css">
</head><body>
<div id="card" class="kit-card">Hi <img id="icon" src="../kit/icons/star.svg" alt="star"></div>
</body></html>`;

export async function stepKitStyles(ctx) {
  ctx.designTitle = `Kit ${ctx.width}`;
  ctx.slug = await createDesign(ctx, ctx.designTitle, "page");
  ctx.designDir = join(ctx.harness.project, "designs", ctx.slug);
  await writeDesign(ctx, PAGE);
  const frame = await openDesign(ctx);

  const bg = await frame.locator("#card").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(15, 23, 42)", "the kit's own compiled CSS styles the card");

  const iconOk = await frame.locator("#icon").evaluate((el) => el.complete && el.naturalWidth > 0);
  assert.ok(iconOk, "the kit's icon SVG loads from ../kit/icons/");
  ctx.record("a design linking ../kit/app.css and a kit icon renders with the kit's styles");
}
