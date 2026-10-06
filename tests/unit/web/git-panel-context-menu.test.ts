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
 * The rows now live in their own files — the file row, the folder row of the
 * tree view, and a stash — so each is checked where it is written.
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

const read = (name: string) =>
  readFileSync(resolve(import.meta.dir, "../../../src/web/components/git", name), "utf8");

const ROWS = {
  file: read("git-change-row.tsx"),
  folder: read("git-change-tree.tsx"),
  stash: read("git-stash-section.tsx"),
};
const panel = read("git-status-panel.tsx");
const composer = read("git-commit-composer.tsx");

const menusOf = (src: string) =>
  [...src.matchAll(/<ContextMenuContent[\s\S]*?<\/ContextMenuContent>/g)].map((m) => m[0]);

describe("the panel's row menus are the adaptive one", () => {
  it("imports it, and does not reach for radix's context menu directly", () => {
    for (const src of Object.values(ROWS)) {
      expect(src).toMatch(/from "@\/components\/ui\/adaptive-context-menu"/);
      expect(src).not.toMatch(/from "@\/components\/ui\/context-menu"/);
    }
    expect(panel).not.toMatch(/from "@\/components\/ui\/context-menu"/);
  });

  it("has exactly one per kind of row", () => {
    for (const src of Object.values(ROWS)) {
      expect(menusOf(src)).toHaveLength(1);
      expect(src.match(/<ContextMenuTrigger/g)).toHaveLength(1);
    }
  });

  it("keeps the dropdowns that hang off a button dropdowns", () => {
    // The ⋯ menu and the commit button's arrow are what a DropdownMenu is for.
    // Only the *row* menus were the mistake, and a sweep that converted
    // everything named "menu" would be a different bug.
    for (const src of [panel, composer]) {
      expect(src).toMatch(/from "@\/components\/ui\/dropdown-menu"/);
      expect(src).toMatch(/<DropdownMenuTrigger asChild>/);
    }
  });

  it("no longer hand-rolls a press", () => {
    // A private timer here is how the seven-file `touchcancel` bug happened.
    // The adaptive trigger owns the press now, and `long-press-touchcancel`
    // asserts that one is disarmed properly.
    for (const src of [...Object.values(ROWS), panel]) {
      expect(src).not.toMatch(/useLongPress/);
      expect(src).not.toMatch(/onTouchStart/);
      expect(src).not.toMatch(/setTimeout/);
    }
  });
});

describe("the gestures the rows still have to answer", () => {
  it("opens the changes from the row's own button, not from a tap detector", () => {
    // The adaptive trigger provides no tap: it only *suppresses* the click that
    // follows a long press. So the tap has to be a real button, which is also
    // what makes the row reachable by keyboard.
    expect(ROWS.file).toMatch(/<button\s+type="button"\s+className="[^"]*"\s+onClick=\{open\}/);
    expect(ROWS.file).toMatch(/const open = \(\) => \(file\.conflict \? actions\.onResolve\(file\) : actions\.onOpen\(file\)\)/);
  });

  it("leaves the folder row's own button expanding the folder", () => {
    expect(ROWS.folder).toMatch(/onClick=\{\(\) => setExpanded\(!expanded\)\}/);
  });

  it("does not let a press select the text under it", () => {
    // Without this, a long press starts a selection and the sheet opens over a
    // half-highlighted filename.
    for (const src of Object.values(ROWS)) {
      const triggers = [
        ...src.matchAll(/<ContextMenuTrigger asChild>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div\s+(?:ref=\{\w+\}\s+)?className="([^"]*)"/g),
      ];
      expect(triggers).toHaveLength(1);
      expect(triggers[0]![1]).toContain("select-none");
    }
  });

  it("gives the select-all box a full 44px on a phone, outside the header's top border", () => {
    // `h-11` counts the border in Tailwind's border-box, which left the box it stretches to at 43px.
    const header = panel.match(/<div className="([^"]*border-t border-border-soft[^"]*)">/);
    expect(header).not.toBeNull();
    expect(header![1]).toContain("h-11");
    expect(header![1]).toContain("max-md:box-content");
  });

  it("tints a row on hover only where there is a pointer", () => {
    // One row serves both platforms, so a bare `hover:` tint would stick after
    // a tap on a touch screen.
    for (const src of Object.values(ROWS)) {
      const all = src.match(/hover:bg-surface-hover/g) ?? [];
      const guarded = src.match(/can-hover:hover:bg-surface-hover/g) ?? [];
      expect(guarded.length).toBeGreaterThan(0);
      expect(all).toHaveLength(guarded.length);
    }
  });
});

describe("throwing work away is set apart from the rest", () => {
  const DESTRUCTIVE = /Discard changes…|Drop…/;

  it("marks it destructive rather than styling it by hand", () => {
    // `variant` is honoured by both halves of the adaptive item; a `className`
    // of `text-destructive` would colour the radix menu and be dropped by the
    // sheet, which takes its colour from the variant.
    for (const src of Object.values(ROWS)) {
      const [menu] = menusOf(src);
      expect(menu).toMatch(DESTRUCTIVE);
      expect(menu).toMatch(/variant="destructive"[\s\S]*?(Discard changes…|Drop…)/);
      expect(menu).not.toMatch(/className="text-destructive/);
    }
  });

  it("puts a separator above it in every menu", () => {
    for (const src of Object.values(ROWS)) {
      const [menu] = menusOf(src);
      const at = menu!.search(DESTRUCTIVE);
      const sep = menu!.lastIndexOf("<ContextMenuSeparator", at);
      expect(sep).toBeGreaterThan(0);
      expect(sep).toBeLessThan(at);
    }
  });

  it("asks first, every time — the Undo toast is a second chance, not the first", () => {
    // Discard goes through the confirmation from the hover button, the row
    // menu, the folder menu and "Discard all changes…" alike.
    expect(panel).toMatch(/const askDiscard = /);
    expect(panel.match(/askDiscard\(/g)!.length).toBeGreaterThanOrEqual(3);
    expect(panel).not.toMatch(/onDiscard: \(file\) => discard\(/);
  });
});
