/**
 * The containment test behind `?repo=`, and the one thing about it that only
 * shows on Windows: `C:\Users\PC\ppm` and `c:\users\pc\ppm` are the same
 * directory, so a case-sensitive prefix test answers "outside the project" for
 * a path the server itself handed out. The platform is a parameter so both
 * answers can be asserted from one test run.
 */
import { describe, it, expect } from "bun:test";
import { isInsideDir } from "../../../src/services/fs-ops/fs-real-path.ts";

describe("isInsideDir", () => {
  it("accepts the directory itself and anything under it", () => {
    expect(isInsideDir("/home/u/proj", "/home/u/proj", "linux")).toBe(true);
    expect(isInsideDir("/home/u/proj/web", "/home/u/proj", "linux")).toBe(true);
    expect(isInsideDir("/home/u/proj/", "/home/u/proj", "linux")).toBe(true);
  });

  it("refuses a sibling whose name merely starts the same", () => {
    expect(isInsideDir("/home/u/proj-evil", "/home/u/proj", "linux")).toBe(false);
    expect(isInsideDir("/home/u", "/home/u/proj", "linux")).toBe(false);
  });

  it("folds case on Windows, and only there", () => {
    expect(isInsideDir("c:\\users\\pc\\ppm\\web", "C:\\Users\\PC\\ppm", "win32")).toBe(true);
    expect(isInsideDir("C:\\Users\\PC\\PPM", "c:\\users\\pc\\ppm", "win32")).toBe(true);
    // Same two spellings on Linux are two different directories.
    expect(isInsideDir("/home/u/PROJ", "/home/u/proj", "linux")).toBe(false);
  });

  it("still refuses a prefix sibling once case is folded", () => {
    expect(isInsideDir("c:\\users\\pc\\ppm-other", "C:\\Users\\PC\\ppm", "win32")).toBe(false);
  });

  it("treats a backslash as a separator on Windows only", () => {
    // On Linux `/home/u/proj\evil` is a file called `proj\evil` sitting *beside*
    // the project, so accepting it would be the same escape the guard exists for.
    expect(isInsideDir("/home/u/proj\\evil", "/home/u/proj", "linux")).toBe(false);
    expect(isInsideDir("C:\\proj/web", "C:\\proj", "win32")).toBe(true);
  });

  it("does not care whether the parent carries a trailing separator", () => {
    expect(isInsideDir("/home/u/proj/web", "/home/u/proj/", "linux")).toBe(true);
    expect(isInsideDir("C:\\proj\\web", "C:\\proj\\", "win32")).toBe(true);
  });
});
