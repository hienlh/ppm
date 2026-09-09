import { describe, test, expect, afterEach } from "bun:test";
import {
  ATTACHMENT_MAX_DIMENSION,
  downscaleImage,
  encodeType,
} from "../../../src/web/lib/image-resize.ts";
import {
  INLINE_IMAGE_LIMITS,
  selectInlineImages,
} from "../../../src/web/lib/image-resize-limits.ts";

const g = globalThis as Record<string, unknown>;
const saved = { createImageBitmap: g.createImageBitmap, document: g.document };

afterEach(() => {
  g.createImageBitmap = saved.createImageBitmap;
  g.document = saved.document;
});

function imageFile(type = "image/png", bytes = 8): File {
  return new File([new Uint8Array(bytes)], "shot." + type.split("/")[1], { type });
}

/** A decoder that reports the given size and never scales. */
function stubDecoder(width: number, height: number) {
  g.createImageBitmap = async () => ({ width, height, close() {} });
}

/** A canvas whose 2d context and toBlob behave as told. */
function stubCanvas(opts: { ctx?: boolean; blob?: Blob | null } = {}) {
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => (opts.ctx === false ? null : { drawImage() {}, imageSmoothingEnabled: false, imageSmoothingQuality: "" }),
      toBlob: (cb: (b: Blob | null) => void) => cb(opts.blob === undefined ? new Blob([new Uint8Array(4)]) : opts.blob),
    }),
  };
}

describe("encodeType", () => {
  test("keeps the types a canvas can re-encode", () => {
    expect(encodeType("image/jpeg")).toBe("image/jpeg");
    expect(encodeType("image/webp")).toBe("image/webp");
  });

  test("everything else round-trips as png", () => {
    for (const t of ["image/heic", "image/avif", "image/tiff", "image/gif"]) {
      expect(encodeType(t)).toBe("image/png");
    }
  });
});

/**
 * Every path that cannot verify an image's dimensions must report `asis`, because the caller
 * uses that to decide whether the payload may be sent inline. Inlining an unmeasured original
 * risks a size the API refuses — and that refusal is replayed into every later turn.
 */
describe("downscaleImage — when it cannot scale", () => {
  test("a browser without createImageBitmap", async () => {
    g.createImageBitmap = undefined;
    const out = await downscaleImage(imageFile());
    expect(out.kind).toBe("asis");
  });

  test("an image the decoder rejects (HEIC, AVIF, corrupt EXIF)", async () => {
    g.createImageBitmap = async () => { throw new Error("cannot decode"); };
    stubCanvas();
    const out = await downscaleImage(imageFile("image/heic"));
    expect(out.kind).toBe("asis");
    expect(out.file.type).toBe("image/heic");
  });

  test("a canvas that hands back no 2d context", async () => {
    stubDecoder(4000, 3000);
    stubCanvas({ ctx: false });
    expect((await downscaleImage(imageFile())).kind).toBe("asis");
  });

  test("an encoder that answers with null", async () => {
    stubDecoder(4000, 3000);
    stubCanvas({ blob: null });
    expect((await downscaleImage(imageFile())).kind).toBe("asis");
  });

  test("an encoder that answers with an empty blob", async () => {
    stubDecoder(4000, 3000);
    stubCanvas({ blob: new Blob([]) });
    expect((await downscaleImage(imageFile())).kind).toBe("asis");
  });

  test("an SVG, which has no pixels to measure", async () => {
    stubDecoder(4000, 3000);
    stubCanvas();
    expect((await downscaleImage(imageFile("image/svg+xml"))).kind).toBe("asis");
  });
});

describe("downscaleImage — when it can", () => {
  test("scales an oversized image and reports both sizes", async () => {
    stubDecoder(4000, 3000);
    stubCanvas();
    const out = await downscaleImage(imageFile());
    expect(out.kind).toBe("scaled");
    expect(Math.max(out.to!.width, out.to!.height)).toBeLessThanOrEqual(ATTACHMENT_MAX_DIMENSION);
    expect(out.from).toEqual({ width: 4000, height: 3000 });
  });

  test("leaves a small image of an accepted type alone, but marks it sendable", async () => {
    stubDecoder(800, 600);
    stubCanvas();
    const out = await downscaleImage(imageFile("image/png"));
    expect(out.kind).toBe("inlineable");
    expect(out.to).toBeUndefined();
  });

  // The socket takes four types; a small image of any other must not be sent inline.
  test("a small image of a type the socket refuses stays path-only", async () => {
    stubDecoder(800, 600);
    stubCanvas();
    expect((await downscaleImage(imageFile("image/bmp"))).kind).toBe("asis");
  });

  test("an image exactly at the target is not re-encoded", async () => {
    stubDecoder(ATTACHMENT_MAX_DIMENSION, 900);
    stubCanvas();
    const out = await downscaleImage(imageFile());
    expect(out.kind).toBe("inlineable");
  });
});

describe("selectInlineImages", () => {
  const img = (len: number) => ({ imageData: { data: "x".repeat(len), mediaType: "image/png" } });

  test("takes attachments without a payload out of the running", () => {
    expect(selectInlineImages([{}, img(10), {}])).toHaveLength(1);
  });

  test("stops at the image count the socket accepts", () => {
    const many = Array.from({ length: 9 }, () => img(10));
    expect(selectInlineImages(many)).toHaveLength(INLINE_IMAGE_LIMITS.maxImages);
  });

  test("skips a payload over the per-image ceiling", () => {
    const out = selectInlineImages([img(INLINE_IMAGE_LIMITS.maxBase64PerImage + 1), img(10)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.data.length).toBe(10);
  });

  // One attachment that does not fit must not exclude the small ones behind it.
  test("keeps going past an attachment that does not fit the total", () => {
    const per = INLINE_IMAGE_LIMITS.maxBase64PerImage;
    const out = selectInlineImages([img(per), img(1), img(per), img(2)]);
    // The third would take the running total past the frame budget, so it is skipped
    // and the fourth still travels.
    expect(out.map((i) => i.data.length)).toEqual([per, 1, 2]);
  });

  test("nothing to send is an empty list, not a throw", () => {
    expect(selectInlineImages([])).toEqual([]);
  });
});
