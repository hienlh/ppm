/**
 * The chip's `onClick`, not the decision behind it.
 *
 * The bug was that clicking an image chip did nothing: the chip's only handler
 * was gated on `att.textContent`, which an image never has. The fix extracted
 * `chipBodyAction` and wired `preview(att, e.currentTarget)` into the chip —
 * and the suite then asserted the extracted function, the `cursor-pointer`
 * class and a grep for `stopPropagation`, none of which touches the wiring that
 * *was* the bug. Replacing the `preview(...)` call with a comment left 9 pass /
 * 0 fail.
 *
 * So these mount the component and dispatch real clicks. What they read
 * afterwards is the image-overlay store, because "the viewer opened on this
 * image" is the actual behaviour and the store is where that becomes true.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// The DOM is process-wide; hand it back so the next file in this batch is not given one.
afterAll(uninstallDom);

const { AttachmentChips } = await import("../../../src/web/components/chat/attachment-chips.tsx");
const { useImageOverlay } = await import("../../../src/web/stores/image-overlay-store.ts");
type ChatAttachment = import("../../../src/web/components/chat/message-input.tsx").ChatAttachment;

function att(over: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: "a1",
    name: "screenshot.png",
    file: new File([""], "screenshot.png", { type: "image/png" }),
    isImage: true,
    previewUrl: "blob:http://localhost/abc-123",
    status: "ready",
    ...over,
  } as ChatAttachment;
}

let view: Mounted | null = null;

beforeEach(() => { useImageOverlay.getState().close(); });
afterEach(async () => { await view?.unmount(); view = null; });

const render = async (attachments: ChatAttachment[]) => {
  view = await mount(<AttachmentChips attachments={attachments} onRemove={() => {}} />);
  return view.container;
};

describe("clicking an attachment chip", () => {
  it("opens the viewer when the click lands on the chip body, not the thumbnail", async () => {
    const container = await render([att()]);
    // The filename is most of the chip's width and reads as part of the same
    // control; clicking it doing nothing is the bug this fix existed for.
    const name = [...container.querySelectorAll("span")]
      .find((s) => s.textContent === "screenshot.png");
    await click(name ?? null);

    expect(useImageOverlay.getState().src).toBe("blob:http://localhost/abc-123");
    expect(useImageOverlay.getState().alt).toBe("screenshot.png");
  });

  it("opens the viewer from the thumbnail button too", async () => {
    const container = await render([att()]);
    await click(container.querySelector('[aria-label="Preview screenshot.png"]'));
    expect(useImageOverlay.getState().src).toBe("blob:http://localhost/abc-123");
  });

  it("carries the whole row as the gallery, so the arrows are not dead", async () => {
    const container = await render([
      att(),
      att({ id: "a2", name: "second.png", previewUrl: "blob:http://localhost/second" }),
    ]);
    await click(container.querySelector('[aria-label="Preview screenshot.png"]'));

    const { images, index } = useImageOverlay.getState();
    expect(images.map((i) => i.src)).toEqual([
      "blob:http://localhost/abc-123",
      "blob:http://localhost/second",
    ]);
    // The clicked image decides where the viewer starts, not the first one.
    expect(index).toBe(0);

    // Opening the second one replaces the state rather than needing a close
    // first — and a `close()` here would be a store write outside `act`, which
    // React reports as an unwrapped update from the component still mounted.
    await click(container.querySelector('[aria-label="Preview second.png"]'));
    expect(useImageOverlay.getState().index).toBe(1);
    expect(useImageOverlay.getState().src).toBe("blob:http://localhost/second");
  });

  it("does not open the viewer when the remove button is clicked", async () => {
    // The remove button sits inside the chip, so without `stopPropagation` the
    // chip's handler runs too and the viewer opens over a chip being deleted.
    const container = await render([att()]);
    await click(container.querySelector('[aria-label="Remove screenshot.png"]')
      ?? container.querySelector("button:last-of-type"));
    expect(useImageOverlay.getState().src).toBeNull();
  });

  it("a text attachment expands in place instead of opening the viewer", async () => {
    const container = await render([
      att({
        id: "t1", name: "notes.txt", isImage: false, previewUrl: undefined,
        textContent: "hello from a file",
      } as Partial<ChatAttachment>),
    ]);
    // The innermost div carrying the name is the chip; the wrappers above it
    // read the same text and clicking one of those would hit no handler at all.
    const chip = [...container.querySelectorAll("div")]
      .filter((d) => d.textContent?.startsWith("notes.txt")).at(-1);

    expect(container.querySelector("pre")).toBeNull();
    await click(chip ?? null);
    expect(useImageOverlay.getState().src).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("hello from a file");

    // Same chip again folds it away: one handler, two directions.
    await click(chip ?? null);
    expect(container.querySelector("pre")).toBeNull();
  });
});
