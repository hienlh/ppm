/**
 * The branch picker's selected row must not be tinted with `accent`.
 *
 * `globals.css` says it outright — shadcn's `accent` is deliberately a hover
 * *surface* here (`--color-accent` → `--panel-2`) while the brand blue lives in
 * `--color-primary` → `--accent`. A surface at 15% over the panel it is nearly
 * identical to changes almost nothing, and measured in a real browser against
 * the dialog's own background `bg-accent/15` composites to a contrast ratio of
 * **1.01** on a light panel (rgb(243,247,255) → rgb(245,248,255)) and **1.009**
 * on a dark one — a keyboard selection nobody can see. `bg-primary/15` measured
 * 1.21 on both.
 *
 * The class reads perfectly well either way, which is why this is pinned rather
 * than left to review. Same family as the `tailwind-token-exists` test and the
 * `opacity`-is-not-dimming note in CLAUDE.md.
 *
 * Scope is this component only: `bg-accent/15` is used for selection in ~60
 * other files, and sweeping those is a separate change.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PICKER = join(import.meta.dir, "../../../src/web/components/git/branch-picker.tsx");
const STATUS_BAR = join(import.meta.dir, "../../../src/web/components/layout/status-bar.tsx");
const GLOBALS = join(import.meta.dir, "../../../src/web/styles/globals.css");

/** `--color-<name>: var(--<other>)` out of the `@theme` block. */
function themeAlias(name: string): string | null {
  const css = readFileSync(GLOBALS, "utf-8");
  const m = new RegExp(`--color-${name}\\s*:\\s*var\\((--[a-z0-9-]+)\\)`).exec(css);
  return m ? m[1]! : null;
}

describe("the tokens this decision rests on are still what they were", () => {
  test("`accent` is a surface and `primary` is the brand blue", () => {
    // If these ever swap, the assertions below stop meaning anything.
    expect(themeAlias("accent")).toBe("--panel-2");
    expect(themeAlias("primary")).toBe("--accent");
  });
});

describe("branch picker selection", () => {
  const src = readFileSync(PICKER, "utf-8");

  test("the selected and hover rows are tinted from `primary`, never `accent`", () => {
    expect(src).toContain('const SELECTED_ROW = "bg-primary/15');
    expect(src).toContain('const HOVER_ROW = "hover:bg-primary/10"');
  });

  test("no `accent`-derived background survives in the component's CODE", () => {
    // The comments name `bg-accent/15` on purpose — explaining why it is wrong
    // is the point — so strip them before matching, or the note fails its own test.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const offenders = [...code.matchAll(/\b(?:hover:)?bg-accent(?:\/\d+)?\b/g)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});

describe("status bar branch button", () => {
  const src = readFileSync(STATUS_BAR, "utf-8");

  test("the branch button's hover is visible for the same reason", () => {
    const button = src.slice(src.indexOf("aria-label={`Current branch"));
    expect(button).toContain("hover:bg-primary/10");
  });
});
