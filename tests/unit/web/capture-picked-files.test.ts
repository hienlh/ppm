import { describe, it, expect } from "bun:test";
import { capturePickedFiles, type PickableFileList } from "../../../src/web/components/os-explorer/upload/capture-picked-files.ts";

function fakeFile(name: string): File {
  return new File(["x"], name);
}

/** Some Chromium versions empty the `<input>`'s *live* FileList the instant its `value` is
 *  reset — this stand-in reproduces that by going empty as soon as `resetInput` runs. */
function liveFileList(files: File[]): { list: PickableFileList; resetInput: () => void } {
  let emptied = false;
  const list: PickableFileList = {
    get length() {
      return emptied ? 0 : files.length;
    },
    item: (index) => (emptied ? null : (files[index] ?? null)),
  };
  return { list, resetInput: () => { emptied = true; } };
}

describe("capturePickedFiles", () => {
  it("returns every file even when the list goes live-empty the moment the input resets", () => {
    const { list, resetInput } = liveFileList([fakeFile("a.txt"), fakeFile("b.txt")]);
    const files = capturePickedFiles(list, resetInput);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("still calls resetInput exactly once, after reading", () => {
    let resets = 0;
    const { list } = liveFileList([fakeFile("a.txt")]);
    const files = capturePickedFiles(list, () => { resets++; });
    expect(resets).toBe(1);
    expect(files).toHaveLength(1);
  });

  it("returns an empty array for a null list without calling resetInput unsafely", () => {
    let resets = 0;
    const files = capturePickedFiles(null, () => { resets++; });
    expect(files).toEqual([]);
    expect(resets).toBe(1);
  });
});
