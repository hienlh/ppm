import { describe, expect, it } from "bun:test";
import { parseChildMessage, parseParentMessage } from "../../../src/shared/design-bridge-protocol.ts";
import { MAX_SLIDE_IMAGE_BYTES, MAX_SLIDES } from "../../../src/shared/design-slide-doc.ts";
import { parseSlideDoc } from "../../../src/shared/design-slide-doc-parse.ts";

const NONCE = "abcdefghijklmnop";
const REQ = "req_0123456789";
const env = (type: string, body: Record<string, unknown>) => ({ ppm: "design-bridge", v: 1, nonce: NONCE, type, ...body });
const RED = { hex: "FF0000", alpha: 1 };

const deck = (over: Record<string, unknown> = {}) => ({
  width: 1280, height: 720, warnings: ["Slide 1: box shadow"],
  slides: [{
    background: RED,
    items: [
      { kind: "shape", x: 0, y: 0, w: 100, h: 50, fill: RED, border: { widthPx: 2, color: RED }, radiusPx: 4, rotation: 10 },
      { kind: "text", x: 10, y: 10, w: 300, h: 40, align: "left", valign: "top", runs: [{ text: "Hi", bold: true, sizePx: 32, font: "Inter", color: RED }] },
      { kind: "image", x: 0, y: 100, w: 50, h: 50, data: "data:image/png;base64,iVBORw0KGgo=" },
    ],
  }],
  ...over,
});

describe("slides messages", () => {
  it("accepts slides-extract, slides-data and slides-error carrying a request id", () => {
    expect(parseParentMessage(env("slides-extract", { requestId: REQ }))).toEqual({ type: "slides-extract", requestId: REQ });
    const data = parseChildMessage(env("slides-data", { requestId: REQ, doc: deck() }));
    expect(data && data.type === "slides-data" && data.doc.slides[0]!.items.length).toBe(3);
    expect(parseChildMessage(env("slides-error", { requestId: REQ, message: "x".repeat(999) }))).toMatchObject({ type: "slides-error", message: "x".repeat(300) });
  });

  it("rejects a missing or malformed request id", () => {
    for (const requestId of [undefined, "", "short", "has space in it", "x".repeat(65), 5]) {
      expect(parseParentMessage(env("slides-extract", { requestId }))).toBeNull();
      expect(parseChildMessage(env("slides-data", { requestId, doc: deck() }))).toBeNull();
    }
  });
});

describe("parseSlideDoc", () => {
  it("drops a zero rotation and a font name it will not pass on", () => {
    const doc = parseSlideDoc(deck({ slides: [{ items: [
      { kind: "shape", x: 0, y: 0, w: 1, h: 1, fill: RED, rotation: 0 },
      { kind: "text", x: 0, y: 0, w: 1, h: 1, align: "left", valign: "top", runs: [{ text: "a", font: "Bad<font>" }] },
    ] }] }))!;
    expect(doc.slides[0]!.items[0]).toEqual({ kind: "shape", x: 0, y: 0, w: 1, h: 1, fill: RED });
    expect(doc.slides[0]!.items[1]).toMatchObject({ runs: [{ text: "a" }] });
  });

  it("rejects the whole deck for one malformed item", () => {
    const bad = (item: Record<string, unknown>) => parseSlideDoc(deck({ slides: [{ items: [item] }] }));
    for (const item of [
      { kind: "shape", x: 0, y: 0, w: 1, h: 1 },
      { kind: "shape", x: 0, y: 0, w: 0, h: 1, fill: RED },
      { kind: "shape", x: Infinity, y: 0, w: 1, h: 1, fill: RED },
      { kind: "shape", x: 0, y: 0, w: 1, h: 1, fill: { hex: "red", alpha: 1 } },
      { kind: "shape", x: 0, y: 0, w: 1, h: 1, fill: { hex: "FF0000", alpha: 2 } },
      { kind: "text", x: 0, y: 0, w: 1, h: 1, align: "left", valign: "top", runs: [] },
      { kind: "text", x: 0, y: 0, w: 1, h: 1, align: "middle", valign: "top", runs: [{ text: "a" }] },
      { kind: "text", x: 0, y: 0, w: 1, h: 1, align: "left", valign: "top", runs: [{ text: 5 }] },
      { kind: "image", x: 0, y: 0, w: 1, h: 1, data: "data:image/svg+xml;base64,PHN2Zz4=" },
      { kind: "image", x: 0, y: 0, w: 1, h: 1, data: "https://evil.example/x.png" },
      { kind: "image", x: 0, y: 0, w: 1, h: 1, data: "data:image/png;base64,AA<script>" },
      { kind: "video", x: 0, y: 0, w: 1, h: 1 },
    ]) {
      expect(bad(item)).toBeNull();
    }
    expect(parseSlideDoc(deck({ width: 0 }))).toBeNull();
    expect(parseSlideDoc(deck({ slides: [] }))).toBeNull();
    expect(parseSlideDoc(deck({ slides: Array.from({ length: MAX_SLIDES + 1 }, () => ({ items: [] })) }))).toBeNull();
    expect(parseSlideDoc(deck({ warnings: [5] }))).toBeNull();
  });

  it("caps the total image payload", () => {
    const half = "data:image/png;base64," + "A".repeat(MAX_SLIDE_IMAGE_BYTES / 2);
    const image = { kind: "image", x: 0, y: 0, w: 1, h: 1, data: half };
    expect(parseSlideDoc(deck({ slides: [{ items: [image] }] }))).not.toBeNull();
    expect(parseSlideDoc(deck({ slides: [{ items: [image] }, { items: [image] }] }))).toBeNull();
  });
});
