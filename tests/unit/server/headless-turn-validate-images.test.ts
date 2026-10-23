import { describe, it, expect } from "bun:test";
import { validateChatImages } from "../../../src/shared/validate-chat-images.ts";
import { validateHeadlessSend } from "../../../src/server/ws/chat-headless-turn-helpers.ts";

/** The validator both the WS `message` handler and the headless turn run. */
describe("validateChatImages", () => {
  it("returns null for no images or an empty array", () => {
    expect(validateChatImages(undefined)).toBeNull();
    expect(validateChatImages([])).toBeNull();
  });

  it("returns null for a valid set of images", () => {
    expect(validateChatImages([
      { data: "abc", mediaType: "image/png" },
      { data: "def", mediaType: "image/jpeg" },
    ])).toBeNull();
  });

  it("rejects more than 5 images with a distinct message", () => {
    const images = Array.from({ length: 6 }, () => ({ data: "x", mediaType: "image/png" }));
    expect(validateChatImages(images)).toBe("Max 5 images per message");
  });

  it("rejects an oversized image with a distinct message", () => {
    const huge = "a".repeat(7_000_001);
    expect(validateChatImages([{ data: huge, mediaType: "image/png" }])).toBe("Image too large (max 5MB)");
  });

  it("rejects an unsupported media type with a distinct message naming it", () => {
    expect(validateChatImages([{ data: "abc", mediaType: "image/tiff" }])).toBe("Unsupported image type: image/tiff");
  });

  it("rejects an image that is not an object of two strings", () => {
    expect(validateChatImages([{ data: 1, mediaType: "image/png" } as never])).toBe("Each image needs data and mediaType");
  });

  it("accepts every documented supported type", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(validateChatImages([{ data: "abc", mediaType }])).toBeNull();
    }
  });
});

describe("validateHeadlessSend", () => {
  it("requires content unless an image is attached", () => {
    expect(validateHeadlessSend(null)).toBe("content is required");
    expect(validateHeadlessSend({ content: "   " })).toBe("content is required");
    expect(validateHeadlessSend({ content: "", images: [{ data: "x", mediaType: "image/png" }] })).toBeNull();
  });

  it("caps the content and bounds the budget", () => {
    expect(validateHeadlessSend({ content: "x".repeat(1_000_001) })).toContain("too large");
    for (const timeoutMs of [999, 86_400_001, 1500.5, "60000", null, Number.NaN]) {
      expect(validateHeadlessSend({ content: "hi", timeoutMs })).toContain("timeoutMs");
    }
    expect(validateHeadlessSend({ content: "hi", timeoutMs: 1_000 })).toBeNull();
  });

  it("hands the images to the shared validator", () => {
    expect(validateHeadlessSend({ content: "hi", images: "nope" })).toBe("images must be an array");
    expect(validateHeadlessSend({ content: "hi", images: [{ data: "x", mediaType: "image/tiff" }] })).toContain("Unsupported image type");
  });
});
