import { describe, test, expect } from "bun:test";
import { hasAnimationMarker } from "../../../src/web/lib/image-animation.ts";

const bytes = (...parts: string[]) => new TextEncoder().encode(parts.join(""));

/**
 * Re-encoding through a canvas keeps one frame, so an animation that reaches the downscaler
 * comes out silently flattened. For a screen recording pasted into a chat the motion is the
 * whole point, which is why these formats are recognised before any scaling decision.
 */
describe("hasAnimationMarker", () => {
  test("a GIF is assumed animated — a still one cannot be proven from a prefix", () => {
    expect(hasAnimationMarker("image/gif", bytes("GIF89a"))).toBe(true);
  });

  test("an animated WebP declares ANIM", () => {
    expect(hasAnimationMarker("image/webp", bytes("RIFF....WEBPVP8XANIM"))).toBe(true);
  });

  test("a still WebP does not", () => {
    expect(hasAnimationMarker("image/webp", bytes("RIFF....WEBPVP8 "))).toBe(false);
  });

  test("an animated PNG declares acTL", () => {
    expect(hasAnimationMarker("image/png", bytes("\x89PNG\r\n\x1a\n....IHDR....acTL"))).toBe(true);
  });

  test("a plain PNG does not", () => {
    expect(hasAnimationMarker("image/png", bytes("\x89PNG\r\n\x1a\n....IHDR....IDAT"))).toBe(false);
  });

  test("a JPEG has no animated form to look for", () => {
    expect(hasAnimationMarker("image/jpeg", bytes("\xff\xd8\xff"))).toBe(false);
  });

  test("an empty header answers false rather than throwing", () => {
    expect(hasAnimationMarker("image/png", new Uint8Array())).toBe(false);
  });
});
