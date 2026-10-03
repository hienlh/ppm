import { afterAll, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installDom, uninstallDom } from "../../helpers/react-dom";
installDom();
afterAll(() => uninstallDom());
const { reserveLightbulbGutter, LIGHTBULB_GUTTER_CLASS } = await import("../../../src/web/lib/monaco-lightbulb-gutter");

const Lane = { Left: 1, Center: 2, Right: 3 };

it("holds the glyph margin at two lanes without taking the bulb's cell or its click", () => {
  const widgets: any[] = [];
  const options: any[] = [];
  const editor = { addGlyphMarginWidget: (w: unknown) => widgets.push(w), updateOptions: (o: unknown) => options.push(o) } as any;
  reserveLightbulbGutter(editor, { editor: { GlyphMarginLane: Lane } } as any);

  // Monaco's margin is one lane per lane in use on the busiest line, and the bulb is drawn in
  // the left one — so both lanes, on one shared line.
  const positions = widgets.map((w) => w.getPosition());
  expect(positions.map((p) => p.lane).sort()).toEqual([Lane.Left, Lane.Right]);
  expect(new Set(positions.map((p) => p.range.startLineNumber)).size).toBe(1);
  expect(positions.every((p) => p.range.startLineNumber === p.range.endLineNumber)).toBe(true);
  // The bulb's decoration has zIndex 0, and Monaco draws only the highest glyph in a cell.
  expect(positions.every((p) => p.zIndex < 0)).toBe(true);
  expect(widgets.every((w) => w.getDomNode().style.pointerEvents === "none")).toBe(true);
  expect(new Set(widgets.map((w) => w.getId())).size).toBe(2);
  expect(options).toEqual([{ extraEditorClassName: LIGHTBULB_GUTTER_CLASS }]);
});

it("centres the bulb only in an editor that holds the second lane", () => {
  const css = readFileSync(resolve(import.meta.dir, "../../../src/web/styles/globals.css"), "utf8");
  const rule = css.match(/([^{}]*codicon-gutter-lightbulb[^{}]*)\{([^}]*)\}/);
  expect(rule, "globals.css has no rule for the gutter lightbulb").not.toBeNull();
  expect(rule![1]).toContain(`.monaco-editor.${LIGHTBULB_GUTTER_CLASS} `);
  expect(rule![2]).toContain("transform: translateX(50%)");
});
