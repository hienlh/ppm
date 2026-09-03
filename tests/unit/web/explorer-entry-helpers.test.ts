import { describe, it, expect } from "bun:test";
import {
  dirnameOf,
  formatMode,
  formatSize,
  joinPath,
  suffixName,
} from "../../../src/web/components/os-explorer/format-file-meta.ts";
import {
  sortAndFilterEntries,
  totalSize,
} from "../../../src/web/components/os-explorer/sort-and-filter-entries.ts";
import type { FsEntry } from "../../../src/web/lib/fs-api.ts";

const file = (name: string, size: number, modified: string): FsEntry => ({
  name,
  path: `/root/${name}`,
  type: "file",
  kind: "file",
  size,
  modified,
});
const dir = (name: string): FsEntry => ({
  name,
  path: `/root/${name}`,
  type: "directory",
  kind: "directory",
  modified: "2026-01-01T00:00:00.000Z",
});

describe("dirnameOf", () => {
  it("walks up a POSIX path", () => {
    expect(dirnameOf("/home/pc/notes.md", "/")).toBe("/home/pc");
    expect(dirnameOf("/home", "/")).toBe("/");
  });

  it("keeps the trailing separator on a Windows drive root", () => {
    expect(dirnameOf("C:\\Users\\PC", "\\")).toBe("C:\\Users");
    expect(dirnameOf("C:\\Users", "\\")).toBe("C:\\");
  });

  it("ignores a trailing separator on the input", () => {
    expect(dirnameOf("/home/pc/", "/")).toBe("/home");
  });
});

describe("joinPath", () => {
  it("does not double the separator at a root", () => {
    expect(joinPath("C:\\", "Users", "\\")).toBe("C:\\Users");
    expect(joinPath("/", "home", "/")).toBe("/home");
    expect(joinPath("/home", "pc", "/")).toBe("/home/pc");
  });
});

describe("suffixName", () => {
  it("inserts the counter before the extension", () => {
    expect(suffixName("report.pdf", 2)).toBe("report (2).pdf");
  });

  it("appends when there is no extension", () => {
    expect(suffixName("README", 3)).toBe("README (3)");
  });

  it("treats a leading dot as part of the name", () => {
    expect(suffixName(".gitignore", 2)).toBe(".gitignore (2)");
  });
});

describe("formatSize / formatMode", () => {
  it("scales byte counts", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(undefined)).toBe("");
  });

  it("renders POSIX permission bits as octal", () => {
    expect(formatMode(0o100644)).toBe("644");
    expect(formatMode(0o40755)).toBe("755");
    expect(formatMode(undefined)).toBe("");
  });
});

describe("sortAndFilterEntries", () => {
  const entries = [
    file("banana.txt", 300, "2026-01-03T00:00:00.000Z"),
    dir("zebra"),
    file("apple.md", 100, "2026-01-05T00:00:00.000Z"),
    dir("alpha"),
    file("file10.txt", 200, "2026-01-01T00:00:00.000Z"),
    file("file9.txt", 50, "2026-01-02T00:00:00.000Z"),
  ];
  const names = (list: FsEntry[]) => list.map((e) => e.name);

  it("keeps directories above files whatever the sort column", () => {
    for (const key of ["name", "size", "modified", "kind"] as const) {
      const sorted = sortAndFilterEntries(entries, "", { key, dir: "asc" });
      expect(sorted.slice(0, 2).every((e) => e.type === "directory")).toBe(true);
    }
  });

  it("sorts names naturally, so file9 comes before file10", () => {
    const sorted = sortAndFilterEntries(entries, "", { key: "name", dir: "asc" });
    expect(names(sorted)).toEqual(["alpha", "zebra", "apple.md", "banana.txt", "file9.txt", "file10.txt"]);
  });

  it("reverses within each group when descending", () => {
    const sorted = sortAndFilterEntries(entries, "", { key: "name", dir: "desc" });
    expect(names(sorted)).toEqual(["zebra", "alpha", "file10.txt", "file9.txt", "banana.txt", "apple.md"]);
  });

  it("sorts by size and by modified time", () => {
    expect(names(sortAndFilterEntries(entries, "", { key: "size", dir: "asc" })).slice(2))
      .toEqual(["file9.txt", "apple.md", "file10.txt", "banana.txt"]);
    expect(names(sortAndFilterEntries(entries, "", { key: "modified", dir: "asc" })).slice(2))
      .toEqual(["file10.txt", "file9.txt", "banana.txt", "apple.md"]);
  });

  it("reverses size and modified time when descending", () => {
    expect(names(sortAndFilterEntries(entries, "", { key: "size", dir: "desc" })).slice(2))
      .toEqual(["banana.txt", "file10.txt", "apple.md", "file9.txt"]);
    expect(names(sortAndFilterEntries(entries, "", { key: "modified", dir: "desc" })).slice(2))
      .toEqual(["apple.md", "banana.txt", "file9.txt", "file10.txt"]);
  });

  it("sorts by kind (extension), falling back to natural name order within the same extension", () => {
    // Extensions: apple.md < banana.txt == file9.txt == file10.txt ("txt"); "txt" files then
    // break the tie by name, numerically ("file9" before "file10", as in the name-sort test).
    expect(names(sortAndFilterEntries(entries, "", { key: "kind", dir: "asc" })).slice(2))
      .toEqual(["apple.md", "banana.txt", "file9.txt", "file10.txt"]);
    expect(names(sortAndFilterEntries(entries, "", { key: "kind", dir: "desc" })).slice(2))
      .toEqual(["file10.txt", "file9.txt", "banana.txt", "apple.md"]);
  });

  it("filters case-insensitively on a substring and leaves the input untouched", () => {
    const before = names(entries);
    // Only "alpha" contains the substring "al" — "banana.txt" and "apple.md" do not.
    const sorted = sortAndFilterEntries(entries, "AL", { key: "name", dir: "asc" });
    expect(names(sorted)).toEqual(["alpha"]);
    expect(names(entries)).toEqual(before);
  });
});

describe("totalSize", () => {
  it("counts files only — a directory has no meaningful size", () => {
    expect(totalSize([file("a", 100, "2026-01-01T00:00:00.000Z"), dir("d")])).toBe(100);
  });
});
