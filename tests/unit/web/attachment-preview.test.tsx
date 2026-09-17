/**
 * An attached image has to be openable before the message is sent, and the touch
 * targets that make that possible must not reach into each other.
 *
 * The chip drew a 20px thumbnail and the name, and clicking it did nothing at all:
 * the chip's only handler was gated on `att.textContent`, which an image never has.
 * So the one attachment you would most want to check before sending — a screenshot,
 * pasted and silently downscaled — was the one thing in the composer that could not
 * be looked at.
 *
 * Everything here is read off a **mounted** component. It used to be read off the
 * file: `renderToStaticMarkup` for the markup half and `readFileSync` plus regexes
 * over `attachment-chips.tsx` for the target arithmetic. Both pass against a
 * component that never renders, and the source regexes were worse than that — they
 * could not see whether a class was actually *applied*, so threading `coarse`
 * wrongly, or losing a class inside `cn()`, left every assertion green while the
 * overlap they exist to prevent came back.
 *
 * What they still cannot do is measure: happy-dom runs no layout and the Tailwind
 * stylesheet is not loaded, so every rect is zero and the numbers below come from
 * the class names on the real elements. That is written down rather than implied.
 * The blob-URL bookkeeping is an effect covered in `attachment-chip-click.test.tsx`,
 * which drives the clicks; this file owns the arithmetic and the markup contract.
 */
import { describe, it, expect, afterEach, afterAll } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// The DOM is process-wide; hand it back so the next file in this batch is not given one.
afterAll(uninstallDom);

const { AttachmentChips, chipBodyAction } = await import("../../../src/web/components/chat/attachment-chips.tsx");
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

/**
 * The pointer kind the component is rendered under.
 *
 * `usePrefersCoarsePointer` reads `window.matchMedia`, which is the happy-dom
 * window's own method rather than the `globalThis` copy — assigning only the
 * latter leaves the hook reading happy-dom's answer, which is "fine pointer" for
 * every query. Nothing restores this because `uninstallDom()` discards the whole
 * window; it does not outlive the file.
 */
function setPointer(kind: "coarse" | "fine"): void {
  (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (query: string) => ({
    matches: kind === "coarse" && query.includes("pointer: coarse"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
}

let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

async function render(attachments: ChatAttachment[], pointer: "coarse" | "fine" = "coarse") {
  setPointer(pointer);
  view = await mount(<AttachmentChips attachments={attachments} onRemove={() => {}} />);
  return view.container;
}

/** Tailwind's spacing scale: one unit is 0.25rem at the app's 16px root. */
const px = (units: string): number => Number(units) * 4;

/**
 * One spacing value off a rendered element's class list.
 *
 * `getAttribute("class")` rather than `.className`, which is an `SVGAnimatedString`
 * on the icon elements and matches nothing as a string.
 */
function unit(el: Element | null | undefined, pattern: RegExp, what: string): number {
  expect(el, `${what}: no such element in the render`).toBeTruthy();
  const classes = el!.getAttribute("class") ?? "";
  const found = classes.match(pattern);
  expect(found, `${what}: ${pattern} is not in "${classes}"`).toBeTruthy();
  return px(found![1]!);
}

const row = (c: Element) => c.querySelector("[data-image-gallery]");
const removeButton = (c: Element) => c.querySelector('[aria-label^="Remove"]');
const previewButton = (c: Element) => c.querySelector('[aria-label^="Preview"]');

describe("an image chip opens the viewer", () => {
  it("renders a named button around the thumbnail", async () => {
    const container = await render([att()]);
    const button = container.querySelector('button[aria-label="Preview screenshot.png"]');
    // A button, not a handler on the chip: the chip already holds the remove button,
    // and a button inside a button is invalid — it also makes the preview reachable
    // by keyboard, which the chip never was.
    expect(button?.tagName).toBe("BUTTON");
  });

  it("tags the image and the row for the gallery", async () => {
    // Both halves are needed. `collectGallery` walks up to the root and collects the
    // tagged images inside it; either one missing yields an empty gallery, which
    // opens the viewer with dead arrows and looks like there was only one image.
    const container = await render([att(), att({ id: "a2", name: "second.png", previewUrl: "blob:x/2" })]);
    expect(row(container)).toBeTruthy();
    expect(row(container)!.querySelectorAll("[data-gallery-item]").length).toBe(2);
  });

  it("leaves the other attachment kinds exactly as they were", async () => {
    // A text attachment expands inline and must not grow a preview button; a
    // non-image file has no thumbnail to open at all.
    const text = await render([
      att({ id: "t", name: "output.txt", isImage: false, previewUrl: undefined, textContent: "hello" } as Partial<ChatAttachment>),
    ]);
    expect(previewButton(text)).toBeNull();
    // Its own affordance, unchanged: the terminal glyph and the chevron that says the
    // body expands in place. (The body itself only renders once expanded, which is a
    // click — driven in `attachment-chip-click.test.tsx`.)
    expect(text.querySelector('[data-icon="TerminalSquare"]')).toBeTruthy();
    expect(text.querySelector('[data-icon="ChevronDown"]')).toBeTruthy();

    const file = await render([att({ id: "f", name: "notes.pdf", isImage: false, previewUrl: undefined })]);
    expect(previewButton(file)).toBeNull();
  });

  it("still shows what the resize did, and the remove button", async () => {
    const container = await render([
      att({ resized: { from: { width: 2400, height: 1200 }, to: { width: 1400, height: 700 } } } as Partial<ChatAttachment>),
    ]);
    expect(container.textContent).toContain("1400");
    expect(container.querySelector('[aria-label="Remove screenshot.png"]')).toBeTruthy();
  });

  it("shows the pointer cursor on an image chip, which is what says it is clickable", async () => {
    // The affordance and the handler are one condition now; before the fix an image
    // chip rendered with no `cursor-pointer` at all, which was an honest signal.
    const image = await render([att()]);
    expect(row(image)!.firstElementChild!.getAttribute("class")).toContain("cursor-pointer");

    const plain = await render([att({ isImage: false, previewUrl: undefined })]);
    expect(row(plain)!.firstElementChild!.getAttribute("class")).not.toContain("cursor-pointer");
  });
});

/**
 * The 44px targets reach past the chip they belong to, and a wrapped row puts
 * another chip right under that reach.
 *
 * Both controls are 44px tall while a chip is 26-30px, so each target overhangs
 * by 7-9px on each side. Along a row that was measured and is clear; between two
 * *wrapped* rows at `gap-1.5` it was an 8px overlap, and an overlap means the tap
 * goes to whichever element paints last — a finger under one chip's X removing
 * nothing and opening the preview of the chip below it.
 *
 * The numbers are computed from the classes on the rendered elements rather than
 * pinned as strings, so this fails when the bleed grows or the gap shrinks rather
 * than when someone reformats the file — and fails too when a class stops being
 * applied at all, which is what reading the source could never see.
 */
describe("a wrapped chip row leaves the targets room", () => {
  const TOUCH_TARGET = 44;
  const CHIP_BORDER = 2; // 1px top + 1px bottom
  const TEXT_XS_LEADING = 16; // Tailwind's `text-xs`, which has no class to read it from

  /** The chip with no thumbnail: the shortest one, and still carrying a 44px target. */
  async function shortestChipHeight(): Promise<number> {
    const container = await render([att({ isImage: false, previewUrl: undefined })]);
    const chip = row(container)!.firstElementChild!;
    const remove = removeButton(container)!;
    const removeInk = unit(remove.querySelector("svg"), /\bsize-([\d.]+)/, "remove glyph")
      + unit(remove, /\bp-([\d.]+)\b/, "remove padding") * 2;
    return Math.max(removeInk, TEXT_XS_LEADING)
      + unit(chip, /\bpy-([\d.]+)/, "chip padding") * 2
      + CHIP_BORDER;
  }

  it("keeps the row gap at least as large as the two overhangs it has to separate", async () => {
    const shortestChip = await shortestChipHeight();
    const overhang = (TOUCH_TARGET - shortestChip) / 2;
    expect(shortestChip).toBeLessThan(TOUCH_TARGET); // otherwise there is nothing to prove

    const container = await render([att(), att({ id: "a2", name: "second.png", previewUrl: "blob:x/2" })]);
    const gapY = unit(row(container), /\bgap-y-([\d.]+)/, "wrapped row gap");
    expect(gapY).toBeGreaterThanOrEqual(overhang * 2);
  });

  it("gives both controls a real 44px of height to bleed into", async () => {
    const container = await render([att()]);
    const thumb = previewButton(container)!;
    expect(unit(thumb.querySelector("img"), /\bsize-([\d.]+)/, "thumbnail")
      + unit(thumb, /before:-inset-y-([\d.]+)/, "thumbnail bleed") * 2).toBe(TOUCH_TARGET);

    const remove = removeButton(container)!;
    expect(unit(remove.querySelector("svg"), /\bsize-([\d.]+)/, "remove glyph")
      + unit(remove, /\bp-([\d.]+)\b/, "remove padding") * 2
      + unit(remove, /before:-inset-y-([\d.]+)/, "remove bleed") * 2).toBe(TOUCH_TARGET);
  });

  it("grows nothing on a fine pointer, where there is no finger to miss", async () => {
    // The bleed and the wrapped-row gap both exist only for touch. A mouse gets the
    // dense row it always had, and asserting that is what stops the fix from being
    // applied unconditionally — which reading the source could not tell apart.
    const container = await render([att()], "fine");
    expect(row(container)!.getAttribute("class")).not.toMatch(/\bgap-y-/);
    expect(previewButton(container)!.getAttribute("class")).not.toMatch(/before:-inset-y-/);
    expect(removeButton(container)!.getAttribute("class")).not.toMatch(/before:-inset-y-/);
  });
});

describe("the whole chip is the target, not just the thumbnail", () => {
  /**
   * The thumbnail is 20px of a chip up to 192px wide, so most of what looks like
   * one control was dead: clicking the filename did nothing, and the only way in
   * was to hit the image exactly. `chipBodyAction` is the decision the chip's
   * `onClick` makes; the clicks that reach it are driven in
   * `attachment-chip-click.test.tsx`, including the remove button opting out.
   */
  it("opens the preview for an image", () => {
    expect(chipBodyAction(att())).toBe("preview");
  });

  it("still expands a text attachment instead", () => {
    // Both handlers live on the same element, so adding the image case must not
    // take the inline expansion away from the kind that had it first.
    expect(chipBodyAction(att({ previewUrl: undefined, textContent: "hello" } as Partial<ChatAttachment>))).toBe("expand");
  });

  it("does nothing for a file with neither", () => {
    expect(chipBodyAction(att({ isImage: false, previewUrl: undefined }))).toBe("none");
  });
});
