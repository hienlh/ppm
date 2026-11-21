/**
 * The chat footer's left chips scroll sideways when they do not fit, fading the side that still
 * hides chips. The fade is a mask, and a mask cuts everything inside its element — a chip's
 * popover included — so it has to be lifted while a popover is open. These tests pin the edge
 * decision and the CSS/markup pairing that lifts the mask, which reads correctly in review either
 * way.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrollEdges } from "../../../src/web/hooks/use-scroll-edge-fades";

const root = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("scrollEdges", () => {
  test("content that fits fades neither end", () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
    // Under a pixel of overflow is rounding, not a hidden chip.
    expect(scrollEdges(0, 300, 300.8)).toEqual({ start: false, end: false });
  });

  test("at the start only the end fades", () => {
    expect(scrollEdges(0, 300, 500)).toEqual({ start: false, end: true });
  });

  test("midway both ends fade", () => {
    expect(scrollEdges(100, 300, 500)).toEqual({ start: true, end: true });
  });

  test("at the end only the start fades, fractional scroll positions included", () => {
    expect(scrollEdges(200, 300, 500)).toEqual({ start: true, end: false });
    expect(scrollEdges(199.5, 300, 500)).toEqual({ start: true, end: false });
  });
});

describe("the left chips' scroller", () => {
  const css = read("src/web/styles/globals.css");
  const tab = read("src/web/components/chat/chat-tab.tsx");
  const popover = read("src/web/components/chat/footer-popover.tsx");

  test("scrolls sideways without a scrollbar and is a .footer-chips box", () => {
    const box = tab.match(/data-footer-chips=""\s+className="([^"]+)"/)?.[1] ?? "";
    for (const cls of ["footer-chips", "scrollbar-none", "overflow-x-auto", "overflow-y-hidden", "min-w-0"]) {
      expect(box.split(/\s+/)).toContain(cls);
    }
    expect(box).not.toMatch(/(^|\s)relative(\s|$)/);
  });

  test("fades by mask, and lifts the mask while a footer popover is open", () => {
    expect(css).toMatch(/\.footer-chips\s*\{[^}]*mask-image:\s*linear-gradient/);
    expect(css).toMatch(/\.footer-chips\[data-fade-start\]/);
    expect(css).toMatch(/\.footer-chips\[data-fade-end\]/);
    expect(css).toMatch(/\.footer-chips:has\(\[data-footer-popover\]\)\s*\{[^}]*mask-image:\s*none/);
    // The attribute the rule looks for is the one the desktop panel carries.
    expect(popover).toMatch(/data-footer-popover=\{label\}/);
  });
});
