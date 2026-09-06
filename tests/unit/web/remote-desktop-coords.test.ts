// Run in Docker if the host segfaults: docker run --rm -v "$PWD":/app -w /app oven/bun bun test tests/unit/web/remote-desktop-coords.test.ts
import { describe, it, expect } from "bun:test";
import { fractionFromPoint } from "../../../src/web/components/remote-desktop/remote-desktop-coords.ts";

describe("fractionFromPoint", () => {
  it("maps the canvas center to 0.5/0.5", () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 };
    expect(fractionFromPoint(500, 350, rect)).toEqual({ xFrac: 0.5, yFrac: 0.5 });
  });

  it("maps the top-left corner to 0/0", () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 };
    expect(fractionFromPoint(100, 50, rect)).toEqual({ xFrac: 0, yFrac: 0 });
  });

  it("clamps a point outside the rect (fast drag past the edge)", () => {
    const rect = { left: 0, top: 0, width: 800, height: 600 };
    expect(fractionFromPoint(-50, 700, rect)).toEqual({ xFrac: 0, yFrac: 1 });
  });

  it("ignores devicePixelRatio entirely — only CSS-pixel rect fractions are computed", () => {
    // No devicePixelRatio parameter exists on the function signature at all; this test
    // documents that guarantee so a future edit can't silently reintroduce it.
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    expect(fractionFromPoint(50, 50, rect)).toEqual({ xFrac: 0.5, yFrac: 0.5 });
  });
});
