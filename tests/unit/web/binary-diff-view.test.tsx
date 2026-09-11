/**
 * What a diff shows for a file Monaco cannot render.
 *
 * The viewer used to hand every file to the diff editor, so a changed PNG came
 * back as thousands of lines of U+FFFD with a "this document contains many
 * invisible unicode characters" banner over it. The two answers here are VS
 * Code's: draw the image when there is an image to draw, and otherwise say so
 * and offer the bytes anyway.
 *
 * Effects do not run under `renderToStaticMarkup`, so the image panes are
 * asserted by their frame — labels and sizes — rather than by an `<img>` that
 * only exists once a fetch has resolved.
 */
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BinaryDiffView,
  BinaryViewSwitcher,
  canPreviewBinary,
  shortRef,
  type BinaryDiffSide,
} from "../../../src/web/components/editor/binary-diff-view.tsx";

/** VS Code's wording, which is what makes this recognisable as the same thing. */
const PLACEHOLDER =
  "The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.";

function side(over: Partial<BinaryDiffSide> = {}): BinaryDiffSide {
  return { url: "/api/project/p/git/file-blob?file=logo.png&ref=HEAD", label: "HEAD", size: 2048, ...over };
}

function markup(
  filePath: string,
  original = side(),
  modified = side({ label: "Working Tree", size: 4096 }),
  mode: "preview" | "text" = "preview",
) {
  return renderToStaticMarkup(
    <BinaryDiffView
      filePath={filePath}
      mode={mode}
      original={original}
      modified={modified}
      onOpenAnyway={() => {}}
    />,
  );
}

describe("an image is drawn, not described", () => {
  it("frames both versions with a name and a size", () => {
    const html = markup("assets/logo.png");
    expect(html).not.toContain("The file is not displayed");
    expect(html).toContain("HEAD");
    expect(html).toContain("Working Tree");
    // The sizes are the thing an image diff is usually opened to compare.
    expect(html).toContain("2 KB");
    expect(html).toContain("4 KB");
  });

  it("draws the one version there is when a file was added or deleted", () => {
    // VS Code opens an untracked image as a plain preview. There is nothing to
    // compare it against, so a second pane captioned "not in HEAD" would be
    // chrome around an empty box.
    const html = markup("assets/logo.png", side({ url: null, size: null }));
    expect(html).not.toContain("Not in HEAD");
    expect(html).toContain("Working Tree");
    expect(html).toContain("4 KB");
    expect(html).not.toContain("2 KB");
  });
});

describe("anything else gets the placeholder", () => {
  it("uses VS Code's sentence and offers the bytes anyway", () => {
    const html = markup("docs/report.pdf");
    // Collapsed because JSX wraps the sentence across source lines.
    expect(html.replace(/\s+/g, " ")).toContain(PLACEHOLDER);
    expect(html).toContain("Open Anyway");
  });

  it("keeps the button in the thumb zone on a phone and at 44px", () => {
    // An auto top margin eats the free space the centring would have split, so
    // the one button sits at the bottom on a phone and centred from `md:` up.
    const html = markup("docs/report.pdf");
    expect(html).toContain("mt-auto");
    expect(html).toContain("md:mt-0");
    expect(html).toContain("h-11");
  });
});

describe("which files have a preview at all", () => {
  it("is the image set, and deliberately nothing else", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.ico", "A.PNG"]) {
      expect(canPreviewBinary(name)).toBe(true);
    }
    // Video, audio and PDF have viewers in the editor but no diff of two
    // revisions: they stream from a path on disk, not from a git blob.
    for (const name of ["a.pdf", "a.zip", "a.mp4", "a.mp3", "a.docx", "a.exe"]) {
      expect(canPreviewBinary(name)).toBe(false);
    }
  });
});

describe("asking for the text editor is not asking for the bytes", () => {
  it("warns first even for a file it could preview", () => {
    // VS Code answers "Reopen with Text Editor" on a PNG with this same
    // placeholder; the bytes only print once Open Anyway is pressed. Skipping
    // the gate is what put a megabyte of U+FFFD on screen unasked.
    const html = markup("assets/logo.png", side(), side({ label: "Working Tree", size: 4096 }), "text");
    expect(html.replace(/\s+/g, " ")).toContain(PLACEHOLDER);
    expect(html).toContain("Open Anyway");
    expect(html).not.toContain("Working Tree");
  });
});

describe("switching between the image and its bytes", () => {
    it("offers VS Code’s two editors and marks the current one", () => {
    const html = renderToStaticMarkup(<BinaryViewSwitcher mode="preview" onChange={() => {}} />);
    expect(html).toContain("Image Preview");
    expect(html).toContain("Text Editor");
    // Without this the switch to text is a one-way door: the editor has no
    // control of its own to come back with.
    expect(html).toContain("selected");
  });
});

describe("column headers", () => {
  it("shortens a full hash and leaves a name alone", () => {
    expect(shortRef("49662316a1b2c3d4e5f60718293a4b5c6d7e8f90")).toBe("4966231");
    expect(shortRef("HEAD")).toBe("HEAD");
    expect(shortRef("main")).toBe("main");
  });
});
