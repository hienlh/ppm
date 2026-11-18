/**
 * The browser draws its own parts of a form control — the clock in `<input type="time">`, the
 * calendar in a date input, a select's arrow, the default scrollbars — from the page's
 * `color-scheme`, not from PPM's theme tokens. Nothing set it, so on every dark theme those
 * parts were drawn for a light page: the quiet-hours and digest time inputs in Settings → PPM
 * Assistant showed a black clock on a near-black field. The scheme follows the `dark`/`light`
 * class that the boot script and `applyTheme` put on `<html>`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globals = readFileSync(resolve(import.meta.dir, "../../../src/web/styles/globals.css"), "utf8");
const compact = globals.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

describe("color-scheme", () => {
  it("is dark under html.dark and light under html.light", () => {
    expect(compact).toMatch(/html\.dark ?\{ ?color-scheme: ?dark;? ?\}/);
    expect(compact).toMatch(/html\.light ?\{ ?color-scheme: ?light;? ?\}/);
  });
});
