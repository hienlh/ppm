/**
 * The Source Control panel's row menus go through the adaptive context menu.
 *
 * Both of them used to be hand-rolled, and each was wrong in its own way. The
 * *file* row paired a private `useLongPress` with a radix `DropdownMenu`: the
 * press was the bug fixed in the `touchcancel` pass, and what it opened was a
 * dropdown — a small popper anchored to a 20px row, with items sized for a
 * mouse. The *folder* row had no press at all; its trigger was the whole row,
 * and a dropdown trigger opens on **tap**, so tapping a folder opened a menu
 * instead of expanding it and there was no way to expand one on a phone.
 *
 * `@/components/ui/adaptive-context-menu` is the project's answer to both (see
 * the UI rules in CLAUDE.md): a bottom sheet with a backdrop and 44px rows on
 * mobile, radix's right-click menu on desktop, one definition for each.
 *
 * Checked on the source because the interesting part is which component is
 * used, and a hand-rolled menu renders perfectly well in a test — it just
 * behaves wrongly under a thumb. Verified in a browser at 390×844: a held press
 * opens the sheet, a press the browser turns into a scroll does not, the click
 * that follows a press is swallowed, a tap opens the diff, and a tap on a
 * folder expands it.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(import.meta.dir, "../../../src/web/components/git/git-status-panel.tsx"),
  "utf8",
);

/** The menu bodies, without the panel's own toolbar dropdown. */
const rowMenus = [...src.matchAll(/<ContextMenuContent[\s\S]*?<\/ContextMenuContent>/g)].map(
  (m) => m[0],
);

describe("the panel's row menus are the adaptive one", () => {
  it("imports it, and does not reach for radix's context menu directly", () => {
    expect(src).toMatch(/from "@\/components\/ui\/adaptive-context-menu"/);
    expect(src).not.toMatch(/from "@\/components\/ui\/context-menu"/);
  });

  it("has one for the file row and one for the folder row", () => {
    expect(rowMenus).toHaveLength(2);
    expect(src.match(/<ContextMenuTrigger/g)).toHaveLength(2);
  });

  it("keeps the toolbar's dropdown a dropdown", () => {
    // Commit / Commit & Push / Amend hangs off a button, which is what a
    // DropdownMenu is for. Only the *row* menus were the mistake, and a sweep
    // that converted everything named "menu" would be a different bug.
    expect(src).toMatch(/from "@\/components\/ui\/dropdown-menu"/);
    expect(src).toMatch(/<DropdownMenuTrigger asChild>/);
  });

  it("no longer hand-rolls a press", () => {
    // A private timer here is how the seven-file `touchcancel` bug happened.
    // The adaptive trigger owns the press now, and `long-press-touchcancel`
    // asserts that one is disarmed properly.
    expect(src).not.toMatch(/useLongPress/);
    expect(src).not.toMatch(/onTouchStart/);
    expect(src).not.toMatch(/setTimeout/);
  });
});

describe("the gestures the rows still have to answer", () => {
  it("opens the diff from the filename itself, not from a tap detector", () => {
    // The adaptive trigger provides no tap: it only *suppresses* the click that
    // follows a long press. So the tap has to be a real button, which is also
    // what makes the row reachable by keyboard.
    //
    // Only the gesture is pinned here, not the row's typography: this once
    // matched the whole class list and failed against the tree redesign, which
    // changed how the name is sized and truncated and nothing about the tap.
    // `git-file-tree.test.ts` is what pins the appearance.
    expect(src).toMatch(
      /<button\s+type="button"\s+className="flex-1[^"]*"\s+onClick=\{\(\) => onClickFile\(file\)\}/,
    );
  });

  it("leaves the folder row's own button expanding the folder", () => {
    expect(src).toMatch(/onClick=\{\(\) => setExpanded\(!expanded\)\}/);
  });

  it("does not let a press select the text under it", () => {
    // Without this, a long press starts a selection and the sheet opens over a
    // half-highlighted filename.
    for (const trigger of src.matchAll(/<ContextMenuTrigger asChild>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div\s+className="([^"]*)"/g)) {
      expect(trigger[1]).toContain("select-none");
    }
    expect([...src.matchAll(/<ContextMenuTrigger asChild>/g)]).toHaveLength(2);
  });

  it("underlines on hover only where there is a pointer", () => {
    // One row serves both platforms now, so a bare `hover:` would stick after
    // a tap on a touch screen. Counted rather than pattern-negated: a "not
    // preceded by can-" regex matches *inside* `can-hover:hover:underline`,
    // which is how the first version of this failed against correct code.
    const all = src.match(/hover:underline/g) ?? [];
    const guarded = src.match(/can-hover:hover:underline/g) ?? [];
    expect(guarded.length).toBeGreaterThan(0);
    expect(all).toHaveLength(guarded.length);
  });
});

describe("discarding is set apart from the rest", () => {
  it("marks it destructive rather than styling it by hand", () => {
    // `variant` is honoured by both halves of the adaptive item; a `className`
    // of `text-destructive` would colour the radix menu and be dropped by the
    // sheet, which takes its colour from the variant.
    for (const menu of rowMenus) {
      if (!menu.includes("Discard Changes")) continue;
      expect(menu).toMatch(/variant="destructive"[\s\S]*?Discard Changes/);
      expect(menu).not.toMatch(/className="text-destructive/);
    }
  });

  it("puts a separator above it in both menus", () => {
    const withDiscard = rowMenus.filter((m) => m.includes("Discard Changes"));
    expect(withDiscard).toHaveLength(2);
    for (const menu of withDiscard) {
      const sep = menu.indexOf("<ContextMenuSeparator");
      expect(sep).toBeGreaterThan(0);
      expect(sep).toBeLessThan(menu.indexOf("Discard Changes"));
    }
  });
});
