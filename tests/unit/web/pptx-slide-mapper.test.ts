import { describe, expect, it } from "bun:test";
import { mapSlideDocToPptx, pptxColor, pxToIn, pxToPt } from "../../../src/web/lib/design/pptx-slide-mapper";
import type { SlideDoc } from "../../../src/shared/design-slide-doc";

const RED = { hex: "FF0000", alpha: 1 };

describe("pptx units and colours", () => {
  it("converts px to inches at 96 dpi and font px to points at 0.75", () => {
    expect(pxToIn(1280)).toBe(13.3333);
    expect(pxToIn(720)).toBe(7.5);
    expect(pxToIn(48)).toBe(0.5);
    expect(pxToPt(32)).toBe(24);
    expect(pxToPt(15)).toBe(11.25);
  });

  it("turns alpha into transparency and omits it when opaque", () => {
    expect(pptxColor(RED)).toEqual({ color: "FF0000" });
    expect(pptxColor({ hex: "00FF00", alpha: 0.25 })).toEqual({ color: "00FF00", transparency: 75 });
  });
});

describe("mapSlideDocToPptx", () => {
  const doc: SlideDoc = {
    width: 1280,
    height: 720,
    warnings: ["Slide 1: box shadow"],
    slides: [
      {
        background: { hex: "FFFFFF", alpha: 1 },
        items: [
          { kind: "shape", x: 96, y: 48, w: 192, h: 96, fill: { hex: "112233", alpha: 0.5 }, border: { widthPx: 4, color: RED }, radiusPx: 12, rotation: 15 },
          { kind: "shape", x: 0, y: 0, w: 10, h: 10, fill: RED },
          {
            kind: "text", x: 96, y: 192, w: 960, h: 96, align: "center", valign: "middle", lineHeightPx: 40,
            runs: [
              { text: "Hello ", bold: true, sizePx: 32, font: "Inter", color: RED },
              { text: "world", italic: true, underline: true, sizePx: 32, font: "Georgia", breakLine: true },
              { text: "second line", sizePx: 16 },
            ],
          },
          { kind: "image", x: 0, y: 480, w: 96, h: 48, data: "data:image/png;base64,AAAA" },
        ],
      },
      { items: [] },
      { items: [{ kind: "text", x: 0, y: 0, w: 96, h: 96, align: "left", valign: "top", bullet: "number", runs: [{ text: "a", breakLine: true }, { text: "b" }] }] },
    ],
  };

  it("uses LAYOUT_WIDE for a 1280x720 deck and a custom layout otherwise", () => {
    expect(mapSlideDocToPptx(doc).layout).toBe("LAYOUT_WIDE");
    expect(mapSlideDocToPptx({ ...doc, width: 960, height: 540 }).layout).toEqual({ name: "PPM_DESIGN", width: 10, height: 5.625 });
  });

  it("maps shapes with fill, border, radius and rotation", () => {
    const [rounded, plain] = mapSlideDocToPptx(doc).slides[0]!.ops;
    expect(rounded).toEqual({
      kind: "shape", shape: "roundRect",
      options: { x: 1, y: 0.5, w: 2, h: 1, rotate: 15, fill: { color: "112233", transparency: 50 }, line: { color: "FF0000", width: 3 }, rectRadius: 0.125 },
    });
    expect(plain).toEqual({ kind: "shape", shape: "rect", options: { x: 0, y: 0, w: 0.1042, h: 0.1042, fill: { color: "FF0000" } } });
  });

  it("maps text runs with style, size, face, breaks and paragraph alignment", () => {
    const text = mapSlideDocToPptx(doc).slides[0]!.ops[2]!;
    expect(text).toEqual({
      kind: "text",
      runs: [
        { text: "Hello ", options: { bold: true, color: "FF0000", fontSize: 24, fontFace: "Inter" } },
        { text: "world", options: { italic: true, underline: { style: "sng" }, fontSize: 24, fontFace: "Georgia", breakLine: true } },
        { text: "second line", options: { fontSize: 12 } },
      ],
      options: { x: 1, y: 2, w: 10, h: 1, align: "center", valign: "middle", margin: 0, fit: "none", wrap: true, isTextBox: true, lineSpacing: 30 },
    });
  });

  it("maps images, keeps empty slides, and puts a bullet on every paragraph", () => {
    const plan = mapSlideDocToPptx(doc);
    expect(plan.slides[0]!.ops[3]).toEqual({ kind: "image", options: { x: 0, y: 5, w: 1, h: 0.5, data: "data:image/png;base64,AAAA" } });
    expect(plan.slides[0]!.background).toEqual({ color: "FFFFFF" });
    expect(plan.slides[1]).toEqual({ ops: [] });
    const bullets = plan.slides[2]!.ops[0]!;
    expect(bullets.kind === "text" && bullets.runs.map((r) => r.options.bullet)).toEqual([{ type: "number" }, { type: "number" }]);
  });

  it("passes the frame's warnings through and names the fonts PowerPoint must have", () => {
    const { warnings } = mapSlideDocToPptx(doc);
    expect(warnings[0]).toBe("Slide 1: box shadow");
    expect(warnings[1]).toContain("Inter, Georgia");
    expect(mapSlideDocToPptx({ ...doc, slides: [{ items: [] }] }).warnings).toEqual(["Slide 1: box shadow"]);
  });
});
