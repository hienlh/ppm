import { describe, it, expect } from "bun:test";
import {
  AUDIO_EXTS,
  canOpenInPpm,
  extensionOf,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  SQLITE_EXTS,
  TEXT_EXTS,
  TEXT_FILENAMES,
  VIDEO_EXTS,
  viewerKindOf,
  type ViewerKind,
} from "../../../src/web/components/os-explorer/can-open-in-ppm.ts";

/**
 * Every branch the editor tab can take, and the set that drives it. If a viewer is added
 * to `code-editor.tsx` without a set here, the explorer would refuse to open the file it
 * can actually display — this table is what keeps the two in step.
 */
const VIEWER_BRANCHES: { kind: ViewerKind; extensions: string[] }[] = [
  { kind: "image", extensions: [...IMAGE_EXTS] },
  { kind: "video", extensions: [...VIDEO_EXTS] },
  { kind: "audio", extensions: [...AUDIO_EXTS] },
  { kind: "sqlite", extensions: [...SQLITE_EXTS] },
  { kind: "markdown", extensions: [...MARKDOWN_EXTS] },
  { kind: "pdf", extensions: ["pdf"] },
  { kind: "docx", extensions: ["docx"] },
  { kind: "csv", extensions: ["csv"] },
];

describe("viewerKindOf", () => {
  for (const branch of VIEWER_BRANCHES) {
    it(`routes every ${branch.kind} extension to the ${branch.kind} viewer`, () => {
      expect(branch.extensions.length).toBeGreaterThan(0);
      for (const ext of branch.extensions) {
        expect(viewerKindOf(`sample.${ext}`)).toBe(branch.kind);
      }
    });
  }

  it("routes the remaining known text extensions to Monaco", () => {
    const claimed = new Set(VIEWER_BRANCHES.flatMap((b) => b.extensions));
    for (const ext of TEXT_EXTS) {
      if (claimed.has(ext)) continue;
      expect(viewerKindOf(`sample.${ext}`)).toBe("text");
    }
  });

  it("recognises extensionless text files by name", () => {
    for (const name of TEXT_FILENAMES) {
      expect(viewerKindOf(name)).toBe("text");
    }
    expect(viewerKindOf("Dockerfile")).toBe("text");
    expect(viewerKindOf(".gitignore")).toBe("text");
  });

  it("is case-insensitive", () => {
    expect(viewerKindOf("PHOTO.PNG")).toBe("image");
    expect(viewerKindOf("Notes.MD")).toBe("markdown");
  });

  it("uses the last extension of a compound name", () => {
    expect(viewerKindOf("archive.tar.gz")).toBeNull();
    expect(viewerKindOf("component.test.ts")).toBe("text");
  });

  it("returns null for formats no viewer can render", () => {
    for (const name of ["setup.exe", "photo.raw", "disk.iso", "font.woff2", "bundle.zip"]) {
      expect(viewerKindOf(name)).toBeNull();
    }
  });

  it("ignores directory components in the argument", () => {
    expect(viewerKindOf("C:\\Users\\PC\\notes.md")).toBe("markdown");
    expect(viewerKindOf("/home/pc/notes.md")).toBe("markdown");
  });
});

describe("canOpenInPpm", () => {
  it("agrees with viewerKindOf", () => {
    for (const name of ["a.png", "b.exe", "Dockerfile", "c.sqlite3", "d.unknownext"]) {
      expect(canOpenInPpm(name)).toBe(viewerKindOf(name) !== null);
    }
  });
});

describe("extensionOf", () => {
  it("treats a leading dot as part of the name", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf(".env.local")).toBe("local");
  });

  it("returns an empty string when there is no extension", () => {
    expect(extensionOf("Makefile")).toBe("");
  });
});
