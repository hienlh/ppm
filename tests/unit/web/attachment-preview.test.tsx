/**
 * An attached image has to be openable before the message is sent.
 *
 * The chip drew a 20px thumbnail and the name, and clicking it did nothing at all:
 * the chip's only handler was gated on `att.textContent`, which an image never has.
 * So the one attachment you would most want to check before sending — a screenshot,
 * pasted and silently downscaled — was the one thing in the composer that could not
 * be looked at.
 *
 * What is asserted here is the contract that makes the app's existing lightbox
 * reachable: a real button carrying the file's name, the `img` tagged as a gallery
 * member, and a gallery root around the row. Miss the root and `collectGallery`
 * returns nothing, which is not an error — the viewer just opens with the arrows
 * dead and no sign that a second image was ever attached.
 *
 * The blob-URL bookkeeping is an effect and is not covered here; `renderToStaticMarkup`
 * runs no effects. It was checked against a real browser: arrow to the sibling, back,
 * then remove the attachment on screen and watch the viewer close instead of sitting
 * on a revoked URL.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AttachmentChips, chipBodyAction } from "../../../src/web/components/chat/attachment-chips.tsx";
import type { ChatAttachment } from "../../../src/web/components/chat/message-input.tsx";

function att(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "a1",
    name: "screenshot.png",
    file: new File([""], "screenshot.png", { type: "image/png" }),
    isImage: true,
    previewUrl: "blob:http://localhost/abc-123",
    status: "ready",
    ...over,
  };
}

const markup = (attachments: ChatAttachment[]) =>
  renderToStaticMarkup(<AttachmentChips attachments={attachments} onRemove={() => {}} />);

describe("an image chip opens the viewer", () => {
  it("renders a named button around the thumbnail", () => {
    const html = markup([att()]);
    expect(html).toContain('aria-label="Preview screenshot.png"');
    // A button, not a handler on the chip: the chip already holds the remove button,
    // and a button inside a button is invalid — it also makes the preview reachable
    // by keyboard, which the chip never was.
    expect(html).toMatch(/<button[^>]*aria-label="Preview screenshot\.png"/);
  });

  it("tags the image and the row for the gallery", () => {
    // Both halves are needed. `collectGallery` walks up to the root and collects the
    // tagged images inside it; either one missing yields an empty gallery, which
    // opens the viewer with dead arrows and looks like there was only one image.
    const html = markup([att(), att({ id: "a2", name: "second.png", previewUrl: "blob:x/2" })]);
    expect(html).toContain("data-image-gallery");
    expect((html.match(/data-gallery-item/g) ?? []).length).toBe(2);
  });

  it("leaves the other attachment kinds exactly as they were", () => {
    // A text attachment expands inline and must not grow a preview button; a
    // non-image file has no thumbnail to open at all.
    const text = markup([
      att({ id: "t", name: "output.txt", isImage: false, previewUrl: undefined, textContent: "hello" }),
    ]);
    expect(text).not.toContain("Preview");
    // Its own affordance, unchanged: the terminal glyph and the chevron that says the
    // body expands in place. (The body itself only renders once expanded, which needs
    // a click — so it cannot appear in a static render.)
    expect(text).toContain('data-icon="TerminalSquare"');
    expect(text).toContain('data-icon="ChevronDown"');

    const file = markup([
      att({ id: "f", name: "notes.pdf", isImage: false, previewUrl: undefined }),
    ]);
    expect(file).not.toContain("Preview");
  });

  it("still shows what the resize did, and the remove button", () => {
    const html = markup([
      att({ resized: { from: { width: 2400, height: 1200 }, to: { width: 1400, height: 700 } } }),
    ]);
    expect(html).toContain("1400");
    expect(html).toContain('aria-label="Remove screenshot.png"');
  });
});

describe("the whole chip is the target, not just the thumbnail", () => {
  /**
   * The thumbnail is 20px of a chip up to 192px wide, so most of what looks like
   * one control was dead: clicking the filename did nothing, and the only way in
   * was to hit the image exactly. `chipBodyAction` is the decision the chip's
   * `onClick` makes, split out because this suite has no DOM renderer — a real
   * click could not be dispatched at it.
   */
  it("opens the preview for an image", () => {
    expect(chipBodyAction(att())).toBe("preview");
  });

  it("still expands a text attachment instead", () => {
    // Both handlers live on the same element, so adding the image case must not
    // take the inline expansion away from the kind that had it first.
    expect(chipBodyAction(att({ previewUrl: undefined, textContent: "hello" }))).toBe("expand");
  });

  it("does nothing for a file with neither", () => {
    expect(chipBodyAction(att({ isImage: false, previewUrl: undefined }))).toBe("none");
  });

  it("shows the pointer cursor on an image chip, which is what says it is clickable", () => {
    // The affordance and the handler are one condition now; before the fix an image
    // chip rendered with no `cursor-pointer` at all, which was an honest signal.
    expect(markup([att()])).toContain("cursor-pointer");
    expect(markup([att({ isImage: false, previewUrl: undefined })])).not.toContain("cursor-pointer");
  });

  it("keeps the remove button out of it", () => {
    // It stops the event, so it is not one of `chipBodyAction`'s cases — the guard
    // that matters is that the stop is still written.
    const src = readFileSync(
      resolve(import.meta.dir, "../../../src/web/components/chat/attachment-chips.tsx"),
      "utf8",
    );
    const remove = src.slice(src.indexOf("{/* Remove button */}"));
    expect(remove).toContain("e.stopPropagation()");
  });
});
