/**
 * A checked radio item in a menu shows a filled dot. The indicator was `CircleIcon` with
 * `fill-current`, which was a dot under lucide; Fluent's `circle` is a ring drawn as a filled
 * outline with a hole, so filling it changes nothing and every checked item showed an empty ring.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CircleIcon } from "../../../src/web/lib/icons";
import { RadioDot } from "../../../src/web/components/ui/radio-dot";

const UI = resolve(import.meta.dir, "../../../src/web/components/ui");
const MENUS = ["dropdown-menu.tsx", "context-menu.tsx", "adaptive-context-menu.tsx"];

describe("menu radio indicator", () => {
  it("cannot be the circle glyph, which is a ring", () => {
    const d = /\sd="([^"]+)"/.exec(renderToStaticMarkup(<CircleIcon />))?.[1] ?? "";
    // Two subpaths: the outer edge and the hole.
    expect((d.match(/[mM]/g) ?? []).length).toBe(2);
  });

  it("is a filled dot", () => {
    expect(renderToStaticMarkup(<RadioDot />)).toBe('<span aria-hidden="true" class="block size-2 rounded-full bg-current"></span>');
  });

  it("is the dot in every menu primitive", () => {
    for (const file of MENUS) {
      const src = readFileSync(resolve(UI, file), "utf8");
      expect({ file, ring: src.includes("<CircleIcon") }).toEqual({ file, ring: false });
      expect({ file, dot: src.includes("<RadioDot") }).toEqual({ file, dot: true });
    }
  });
});
