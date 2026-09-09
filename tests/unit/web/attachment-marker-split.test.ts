import { describe, test, expect } from "bun:test";
import { splitAttachmentMarkers } from "../../../src/web/lib/attachment-marker-split.ts";

const payload = (chars = 8) => ({ data: "x".repeat(chars), mediaType: "image/png" });

describe("splitAttachmentMarkers", () => {
  test("an image whose payload is going out is announced as included", () => {
    const img = payload();
    const out = splitAttachmentMarkers([{ serverPath: "/up/a.png", imageData: img }], [img]);
    expect(out).toEqual({ inlineImagePaths: ["/up/a.png"], pathOnlyPaths: [] });
  });

  /**
   * The one that matters. Whether an image rides inline is decided by the per-message caps,
   * not by whether it has a payload at all — and a marker chosen from `imageData` alone said
   * "contents included in this message" for an image nothing carried, leaving the model
   * without the picture and without a reason to go and open it.
   */
  test("an image the caps left behind keeps the plain marker", () => {
    const kept = payload();
    const dropped = payload(16);
    const out = splitAttachmentMarkers(
      [
        { serverPath: "/up/kept.png", imageData: kept },
        { serverPath: "/up/dropped.png", imageData: dropped },
      ],
      [kept],
    );
    expect(out.inlineImagePaths).toEqual(["/up/kept.png"]);
    expect(out.pathOnlyPaths).toEqual(["/up/dropped.png"]);
  });

  // A caller that sends no payloads at all — the edit-fork path takes only text — must get
  // the plain markers throughout rather than claiming every image is inline.
  test("no inline set means every attachment travels by path", () => {
    const out = splitAttachmentMarkers(
      [{ serverPath: "/up/a.png", imageData: payload() }, { serverPath: "/up/b.pdf" }],
      [],
    );
    expect(out.inlineImagePaths).toEqual([]);
    expect(out.pathOnlyPaths).toEqual(["/up/a.png", "/up/b.pdf"]);
  });

  test("a non-image attachment is always path-only", () => {
    const img = payload();
    const out = splitAttachmentMarkers(
      [{ serverPath: "/up/a.png", imageData: img }, { serverPath: "/up/b.pdf" }],
      [img],
    );
    expect(out.pathOnlyPaths).toEqual(["/up/b.pdf"]);
  });

  // Nothing to name: an upload that failed has no path, even when its payload is being sent.
  test("an attachment with no uploaded path appears in neither list", () => {
    const img = payload();
    const out = splitAttachmentMarkers([{ imageData: img }], [img]);
    expect(out).toEqual({ inlineImagePaths: [], pathOnlyPaths: [] });
  });

  // Two screenshots of the same thing can be byte-identical; only the picked object is inline.
  test("identical payloads are told apart by which object was picked", () => {
    const first = payload();
    const second = { ...first };
    const out = splitAttachmentMarkers(
      [
        { serverPath: "/up/first.png", imageData: first },
        { serverPath: "/up/second.png", imageData: second },
      ],
      [first],
    );
    expect(out.inlineImagePaths).toEqual(["/up/first.png"]);
    expect(out.pathOnlyPaths).toEqual(["/up/second.png"]);
  });

  test("nothing attached is two empty lists", () => {
    expect(splitAttachmentMarkers([], [])).toEqual({ inlineImagePaths: [], pathOnlyPaths: [] });
  });
});
