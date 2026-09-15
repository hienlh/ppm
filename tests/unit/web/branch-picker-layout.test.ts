/**
 * The picker's desktop height must be bounded by the shell's padding, never by
 * a `vh` cap of its own.
 *
 * `md:pt-[20vh]` beside `max-h-[80vh]` sums to exactly 100vh, so the panel's
 * bottom edge landed on the viewport's: measured in a real browser at 1500x620,
 * `top 124, bottom 620, gap 0` — the last row of the list sliced by the window
 * edge rather than by a visible container, which reads as a dialog overflowing
 * the screen instead of a list that scrolls. With the padding carrying the
 * bound, the gap survives every window height: 62px at 620, 80px at 800, 120px
 * at 1200.
 *
 * The arithmetic is the part worth pinning. Both classes look reasonable on
 * their own and nothing reports the sum.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "../../../src/web/components/git/branch-picker.tsx"),
  "utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The `fixed inset-0` overlay and the `role="dialog"` panel, as class strings. */
function shellClasses(): string {
  return /className="(fixed inset-0 z-50[^"]*)"/.exec(SRC)?.[1] ?? "";
}
function panelClasses(): string {
  return /role="dialog"[\s\S]*?className="([^"]*)"/.exec(SRC)?.[1] ?? "";
}

describe("branch picker desktop height", () => {
  test("the test can still find both class lists", () => {
    // Guards the regexes: a rename would otherwise make every assertion vacuous.
    expect(shellClasses()).toContain("fixed inset-0");
    expect(panelClasses()).toContain("max-h-");
  });

  test("the shell reserves space below the panel on desktop", () => {
    expect(shellClasses()).toMatch(/\bmd:pb-\[/);
  });

  test("the panel is bounded by that padding, not by its own vh cap", () => {
    // `max-h-full` resolves against the flex container's CONTENT box, so the
    // padding is subtracted for free at any viewport height.
    expect(panelClasses()).toContain("md:max-h-full");
  });

  test("top offset plus any desktop vh cap can never reach 100vh", () => {
    const vh = (re: RegExp, s: string) => Number(re.exec(s)?.[1] ?? 0);
    const top = vh(/md:pt-\[(\d+)vh\]/, shellClasses());
    const bottom = vh(/md:pb-\[(\d+)vh\]/, shellClasses());
    // A `md:max-h-[Nvh]` would re-introduce the bug; there must not be one.
    const capped = /md:max-h-\[\d+vh\]/.test(panelClasses());
    expect(capped).toBe(false);
    expect(top).toBeGreaterThan(0);
    expect(top + bottom).toBeLessThan(100);
  });

  test("below `md` it is still a bottom sheet — flush, no side or bottom gap", () => {
    // A sheet *should* sit on the bottom edge, so the padding is desktop-only.
    expect(shellClasses()).toContain("items-end");
    expect(shellClasses()).not.toMatch(/(?<!md:)\bpb-\[/);
    expect(panelClasses()).toContain("rounded-t-xl");
  });
});
