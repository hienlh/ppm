import { describe, it, expect } from "bun:test";
import {
  allAlreadyIn,
  decodeEntryDrag,
  encodeEntryDrag,
  ENTRY_DRAG_MIME,
  isSelfOrDescendant,
  resolveDropOperation,
  toFileUriList,
  type EntryDragPayload,
} from "../../../src/web/components/os-explorer/dnd/entry-drag-payload.ts";

describe("encodeEntryDrag / decodeEntryDrag", () => {
  it("round-trips a payload", () => {
    const payload: EntryDragPayload = { paths: ["C:\\a", "C:\\b"], origin: "explorer" };
    expect(decodeEntryDrag(encodeEntryDrag(payload))).toEqual(payload);
  });

  it("round-trips the optional projectName", () => {
    const payload: EntryDragPayload = { paths: ["/proj/a"], origin: "tree", projectName: "demo" };
    expect(decodeEntryDrag(encodeEntryDrag(payload))).toEqual(payload);
  });

  it("returns null for empty, missing or garbage input", () => {
    expect(decodeEntryDrag(null)).toBeNull();
    expect(decodeEntryDrag(undefined)).toBeNull();
    expect(decodeEntryDrag("")).toBeNull();
    expect(decodeEntryDrag("not json")).toBeNull();
    expect(decodeEntryDrag("42")).toBeNull();
    expect(decodeEntryDrag("null")).toBeNull();
  });

  it("returns null when paths is missing, not an array, or empty after filtering", () => {
    expect(decodeEntryDrag(JSON.stringify({ origin: "explorer" }))).toBeNull();
    expect(decodeEntryDrag(JSON.stringify({ paths: "not-an-array", origin: "explorer" }))).toBeNull();
    expect(decodeEntryDrag(JSON.stringify({ paths: [1, 2, null, ""], origin: "explorer" }))).toBeNull();
  });

  it("drops non-string entries but keeps the valid ones", () => {
    const decoded = decodeEntryDrag(JSON.stringify({ paths: ["/a", 1, null, "/b"], origin: "explorer" }));
    expect(decoded?.paths).toEqual(["/a", "/b"]);
  });

  it("defaults an unrecognised origin to explorer", () => {
    const decoded = decodeEntryDrag(JSON.stringify({ paths: ["/a"], origin: "something-else" }));
    expect(decoded?.origin).toBe("explorer");
  });

  it("omits projectName when it is not a string", () => {
    const decoded = decodeEntryDrag(JSON.stringify({ paths: ["/a"], origin: "tree", projectName: 7 }));
    expect(decoded?.projectName).toBeUndefined();
  });
});

describe("isSelfOrDescendant", () => {
  it("rejects the dragged path itself as a target", () => {
    expect(isSelfOrDescendant(["C:\\a\\b"], "C:\\a\\b")).toBe(true);
  });

  it("rejects a descendant of a dragged folder", () => {
    expect(isSelfOrDescendant(["C:\\a"], "C:\\a\\b")).toBe(true);
  });

  it("allows a sibling or unrelated directory", () => {
    expect(isSelfOrDescendant(["C:\\a"], "C:\\b")).toBe(false);
    expect(isSelfOrDescendant(["C:\\a"], "C:\\ab")).toBe(false);
  });

  it("allows the parent of a dragged folder (moving up is fine)", () => {
    expect(isSelfOrDescendant(["C:\\a\\b"], "C:\\a")).toBe(false);
  });

  it("is case-insensitive on a Windows path", () => {
    expect(isSelfOrDescendant(["C:\\Users\\PC"], "c:\\users\\pc\\sub")).toBe(true);
  });

  it("is case-sensitive on a POSIX path", () => {
    expect(isSelfOrDescendant(["/Users/pc"], "/users/pc/sub")).toBe(false);
  });

  it("checks every path in a multi-select drag", () => {
    expect(isSelfOrDescendant(["/a", "/b"], "/b/child")).toBe(true);
    expect(isSelfOrDescendant(["/a", "/b"], "/c")).toBe(false);
  });
});

describe("allAlreadyIn", () => {
  it("is true when every path's parent is the target directory", () => {
    expect(allAlreadyIn(["/a/one.txt", "/a/two.txt"], "/a")).toBe(true);
  });

  it("is false when any path lives elsewhere", () => {
    expect(allAlreadyIn(["/a/one.txt", "/b/two.txt"], "/a")).toBe(false);
  });

  it("handles a Windows drive root parent", () => {
    expect(allAlreadyIn(["C:\\file.txt"], "C:\\")).toBe(true);
  });
});

describe("resolveDropOperation", () => {
  it("defaults to move with no modifier", () => {
    expect(resolveDropOperation({ ctrlKey: false, altKey: false })).toBe("move");
  });

  it("ctrl switches to copy", () => {
    expect(resolveDropOperation({ ctrlKey: true, altKey: false })).toBe("copy");
  });

  it("alt (macOS's own copy modifier) also switches to copy", () => {
    expect(resolveDropOperation({ ctrlKey: false, altKey: true })).toBe("copy");
  });

  it("either modifier held is still copy", () => {
    expect(resolveDropOperation({ ctrlKey: true, altKey: true })).toBe("copy");
  });
});

describe("toFileUriList", () => {
  it("produces a CRLF-joined file:// list", () => {
    expect(toFileUriList(["/a/b c.txt"])).toBe("file:///a/b%20c.txt");
    expect(toFileUriList(["/a", "/b"])).toBe("file:///a\r\nfile:///b");
  });

  it("normalises Windows separators (the drive colon is percent-encoded like any other segment)", () => {
    expect(toFileUriList(["C:\\Users\\pc"])).toBe("file:///C%3A/Users/pc");
  });
});

describe("ENTRY_DRAG_MIME", () => {
  it("is a stable, namespaced MIME type", () => {
    expect(ENTRY_DRAG_MIME).toBe("application/x-ppm-paths");
  });
});
