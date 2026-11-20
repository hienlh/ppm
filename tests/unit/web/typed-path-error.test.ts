/** What the explorer's path field says when a typed path cannot be opened: plain words, never `ENOENT: …`. */
import { describe, expect, it } from "bun:test";
import { FsError } from "../../../src/web/lib/fs-api";
import { typedPathError, typedPathTarget } from "../../../src/web/components/os-explorer/use-typed-path";

describe("typedPathTarget", () => {
  it("reads a relative path from the folder on screen and leaves absolute ones alone", () => {
    expect(typedPathTarget("photos", "D:\\tiktok\\story")).toBe("D:\\tiktok\\story\\photos");
    expect(typedPathTarget("./src", "/home/me/demo/")).toBe("/home/me/demo/src");
    for (const raw of ["D:\\x", "/srv", "~/Projects", "~"]) expect(typedPathTarget(raw, "C:\\Users")).toBe(raw);
  });
});

const fsError = (code: string, message = "boom") => new FsError(message, code, 400);

describe("typedPathError", () => {
  it("names a missing path, a refused one and a permission problem in plain words", () => {
    expect(typedPathError("D:\\nope", fsError("ENOENT", "ENOENT: no such file or directory, lstat 'D:\\nope'"))).toBe("No folder or file at D:\\nope.");
    expect(typedPathError("\\\\srv\\x", fsError("EDENIED"))).toBe("PPM does not open \\\\srv\\x.");
    expect(typedPathError("/root", fsError("EACCES"))).toBe("PPM is not allowed to read /root.");
  });

  it("keeps any other error's own words", () => {
    expect(typedPathError("/x", new Error("socket hang up"))).toBe("/x: socket hang up");
  });
});
