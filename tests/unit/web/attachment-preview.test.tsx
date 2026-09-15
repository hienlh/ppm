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
import { AttachmentChips } from "../../../src/web/components/chat/attachment-chips.tsx";
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
