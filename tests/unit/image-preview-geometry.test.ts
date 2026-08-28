import { describe, test, expect } from "bun:test";
import {
  dimensionsLabel,
  formatBytes,
  previewLayout,
  TILE_MAX_RATIO,
  TILE_MIN_RATIO,
  TILE_WIDTH,
  TILE_WIDTH_NARROW,
} from "../../src/web/components/chat/image-preview-geometry.ts";

describe("previewLayout", () => {
  test("a square sits inside the clamp and is not cropped", () => {
    const l = previewLayout({ w: 800, h: 800 }, TILE_WIDTH);
    expect(l.variant).toBe("split");
    expect(l.aspect).toBe(1);
    expect(l.fit).toBe("cover");
  });

  test("4:5 and 16:9 keep their own ratio", () => {
    expect(previewLayout({ w: 800, h: 1000 }, TILE_WIDTH).aspect).toBeCloseTo(0.8, 5);
    expect(previewLayout({ w: 1600, h: 900 }, TILE_WIDTH).aspect).toBeCloseTo(1.778, 3);
  });

  // A phone capture cropped to 0.62 would hide its content, so it is fitted instead.
  test("a capture taller than the clamp is fitted at the clamp ratio", () => {
    const l = previewLayout({ w: 540, h: 1170 }, TILE_WIDTH);
    expect(l.variant).toBe("split");
    expect(l.aspect).toBe(TILE_MIN_RATIO);
    expect(l.fit).toBe("contain");
  });

  test("a panorama drops the split and becomes a band at its true ratio", () => {
    const l = previewLayout({ w: 2520, h: 900 }, TILE_WIDTH);
    expect(l.variant).toBe("band");
    expect(l.aspect).toBeCloseTo(2.8, 5);
    expect(l.fit).toBe("contain");
  });

  // 21:9 is 2.33, so the 2.4 threshold keeps it in the split. The design mock labels its
  // 1680×720 sample "past the 2.4 clamp", which its own ratio does not satisfy — the
  // threshold is what both the spec table and this test treat as normative.
  test("a 21:9 image stays a split under the specified 2.4 threshold", () => {
    const l = previewLayout({ w: 1680, h: 720 }, TILE_WIDTH);
    expect(l.aspect).toBeCloseTo(2.333, 3);
    expect(l.variant).toBe("split");
  });

  test("the band boundary follows the max clamp exactly", () => {
    expect(previewLayout({ w: 240, h: 100 }, TILE_WIDTH).variant).toBe("split");
    expect(TILE_MAX_RATIO).toBe(2.4);
    expect(previewLayout({ w: 241, h: 100 }, TILE_WIDTH).variant).toBe("band");
  });

  test("an icon smaller than the tile box is shown natively, never upscaled", () => {
    const l = previewLayout({ w: 48, h: 48 }, TILE_WIDTH);
    expect(l.fit).toBe("native");
    expect(l.variant).toBe("split");
  });

  test("native only applies while the image fits the box at that width", () => {
    // 100px wide fits the 132px tile but not the 64px one.
    expect(previewLayout({ w: 100, h: 100 }, TILE_WIDTH).fit).toBe("native");
    expect(previewLayout({ w: 100, h: 100 }, TILE_WIDTH_NARROW).fit).toBe("cover");
  });

  test("a wide-but-tiny image is still a band, since the band rule comes first", () => {
    expect(previewLayout({ w: 60, h: 20 }, TILE_WIDTH).variant).toBe("band");
  });
});

describe("dimensionsLabel", () => {
  test("reports pixel size", () => {
    expect(dimensionsLabel({ w: 1587, h: 2245 }, "cover")).toBe("1587 × 2245 px");
  });

  test("flags the native case so the reader knows it is not scaled", () => {
    expect(dimensionsLabel({ w: 48, h: 48 }, "native")).toBe("48 × 48 px · shown 1:1");
  });
});

describe("formatBytes", () => {
  test("scales the unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(240 * 1024)).toBe("240 KB");
    expect(formatBytes(1_212_547)).toBe("1.2 MB");
  });
});
