import { describe, it, expect } from "bun:test";
import { mobileTapAction } from "../../../src/web/components/os-explorer/mobile/mobile-tap-action.ts";

describe("mobileTapAction", () => {
  it("opens (navigates into) a directory", () => {
    expect(mobileTapAction({ type: "directory", name: "src" })).toBe("open");
  });

  it("opens a PPM-viewable file", () => {
    expect(mobileTapAction({ type: "file", name: "notes.md" })).toBe("open");
    expect(mobileTapAction({ type: "file", name: "photo.png" })).toBe("open");
  });

  it("surfaces the actions sheet for a file with no viewer", () => {
    expect(mobileTapAction({ type: "file", name: "setup.exe" })).toBe("sheet");
    expect(mobileTapAction({ type: "file", name: "archive.zip" })).toBe("sheet");
  });

  it("is case-insensitive, matching canOpenInPpm", () => {
    expect(mobileTapAction({ type: "file", name: "PHOTO.PNG" })).toBe("open");
  });
});
