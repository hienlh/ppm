import { describe, test, expect } from "bun:test";
import { MAX_IMAGE_DIMENSION, fitWithin } from "../../../src/shared/image-limits.ts";
import { ATTACHMENT_MAX_DIMENSION } from "../../../src/web/lib/image-resize.ts";

describe("fitWithin", () => {
  test("leaves an image that is already under the cap alone", () => {
    expect(fitWithin(1024, 768)).toBeNull();
    expect(fitWithin(MAX_IMAGE_DIMENSION - 1, 10)).toBeNull();
  });

  // The cap is a ceiling, so measuring exactly it is already over — the case that made a
  // whole session unusable while every audit reported nothing wrong.
  test("scales an image measuring exactly the cap", () => {
    const out = fitWithin(MAX_IMAGE_DIMENSION, 1000);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(MAX_IMAGE_DIMENSION - 1);
  });

  test("brings the longest side strictly under the cap", () => {
    for (const [w, h] of [[4000, 3000], [3000, 4000], [2500, 2500], [8000, 100]]) {
      const out = fitWithin(w!, h!)!;
      expect(Math.max(out.width, out.height)).toBeLessThan(MAX_IMAGE_DIMENSION);
    }
  });

  test("keeps the aspect ratio within a pixel", () => {
    const out = fitWithin(4000, 3000)!;
    expect(Math.abs(out.width / out.height - 4000 / 3000)).toBeLessThan(0.01);
  });

  test("scales the taller side when the image is portrait", () => {
    const out = fitWithin(1000, 5000)!;
    expect(out.height).toBe(MAX_IMAGE_DIMENSION - 1);
    expect(out.width).toBeLessThan(out.height);
  });

  test("a square lands square", () => {
    const out = fitWithin(5000, 5000)!;
    expect(out.width).toBe(out.height);
    expect(out.width).toBe(MAX_IMAGE_DIMENSION - 1);
  });

  // An extreme banner would otherwise round its short side to zero, which no encoder accepts.
  test("never rounds a side down to zero", () => {
    const out = fitWithin(20000, 3)!;
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  test("honours a custom cap", () => {
    const out = fitWithin(4000, 2000, 1000)!;
    expect(Math.max(out.width, out.height)).toBe(999);
  });

  test("refuses nonsense dimensions rather than inventing them", () => {
    expect(fitWithin(0, 100)).toBeNull();
    expect(fitWithin(-5, 100)).toBeNull();
    expect(fitWithin(Number.NaN, 100)).toBeNull();
  });
});

// The attachment target must stay under the API's ceiling, or a downscaled image would still
// be refused — and the refusal outlives the turn, since the transcript replays it.
describe("attachment target", () => {
  test("sits below the API ceiling", () => {
    expect(ATTACHMENT_MAX_DIMENSION).toBeLessThan(MAX_IMAGE_DIMENSION);
  });

  test("an image at the attachment target is not re-encoded for one pixel", () => {
    expect(fitWithin(ATTACHMENT_MAX_DIMENSION, 900, ATTACHMENT_MAX_DIMENSION + 1)).toBeNull();
  });
});
