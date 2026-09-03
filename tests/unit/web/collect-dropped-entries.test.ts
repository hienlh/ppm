import { describe, it, expect } from "bun:test";
import {
  collectDroppedEntries,
  sanitizeRelativePath,
} from "../../../src/web/components/os-explorer/upload/collect-dropped-entries.ts";

describe("sanitizeRelativePath", () => {
  it("keeps a plain nested-folder path, normalising backslashes to forward slashes", () => {
    expect(sanitizeRelativePath("folder\\sub\\file.txt")).toBe("folder/sub/file.txt");
  });

  it("strips a leading slash", () => {
    expect(sanitizeRelativePath("/folder/file.txt")).toBe("folder/file.txt");
  });

  it("drops '.' segments", () => {
    expect(sanitizeRelativePath("folder/./file.txt")).toBe("folder/file.txt");
  });

  it("rejects any path containing a '..' segment", () => {
    expect(sanitizeRelativePath("../escape.txt")).toBeNull();
    expect(sanitizeRelativePath("folder/../../escape.txt")).toBeNull();
  });

  it("rejects an empty or all-dot path", () => {
    expect(sanitizeRelativePath("")).toBeNull();
    expect(sanitizeRelativePath(".")).toBeNull();
    expect(sanitizeRelativePath("///")).toBeNull();
  });
});

/** Minimal fake of the (non-standard) File System Entry API, just enough for `walk()`. */
function fakeFileEntry(fullPath: string, file: File) {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (onSuccess: (f: File) => void) => onSuccess(file),
  };
}
function fakeDirEntry(fullPath: string, children: unknown[]) {
  let delivered = false;
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader: () => ({
      readEntries: (onSuccess: (entries: unknown[]) => void) => {
        // Real `readEntries` must be called again to get an empty batch signalling "done" —
        // returning everything on the first call and nothing forever after mirrors that. The
        // flag flips *before* the callback runs: `walk()`'s loop calls back into this
        // synchronously, and flipping it after would recurse forever instead of terminating.
        const batch = delivered ? [] : children;
        delivered = true;
        onSuccess(batch);
      },
    }),
  };
}
function fakeItem(entry: unknown) {
  return { kind: "file", webkitGetAsEntry: () => entry };
}
function fakeDataTransfer(items: unknown[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

describe("collectDroppedEntries", () => {
  it("walks nested folders into forward-slash relative paths, keeping the dropped folder's own name as the root — dropping 'dropped' must land as a 'dropped' folder at the destination, not spill its contents flat", async () => {
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    const tree = fakeDirEntry("/dropped", [
      fakeFileEntry("/dropped/a.txt", a),
      fakeDirEntry("/dropped/sub", [fakeFileEntry("/dropped/sub/b.txt", b)]),
    ]);
    const result = await collectDroppedEntries(fakeDataTransfer([fakeItem(tree)]));
    const byPath = Object.fromEntries(result.map((e) => [e.relativePath, e.file]));
    expect(Object.keys(byPath).sort()).toEqual(["dropped/a.txt", "dropped/sub/b.txt"]);
    expect(byPath["dropped/a.txt"]).toBe(a);
    expect(byPath["dropped/sub/b.txt"]).toBe(b);
  });

  it("drops an entry whose fullPath sanitises to null (defence in depth)", async () => {
    const escapee = new File(["x"], "x.txt");
    const tree = fakeDirEntry("/dropped", [fakeFileEntry("../../escape.txt", escapee)]);
    const result = await collectDroppedEntries(fakeDataTransfer([fakeItem(tree)]));
    expect(result).toEqual([]);
  });

  it("falls back to a flat file list when no item exposes webkitGetAsEntry", async () => {
    const a = new File(["a"], "a.txt");
    const dt = { items: [{ kind: "file" }], files: [a] } as unknown as DataTransfer;
    const result = await collectDroppedEntries(dt);
    expect(result).toEqual([{ file: a, relativePath: "a.txt" }]);
  });
});
