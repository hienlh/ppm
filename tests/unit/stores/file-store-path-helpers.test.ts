import { describe, it, expect } from "bun:test";
import { absoluteProjectPath, relativeProjectPath } from "../../../src/web/stores/file-store.ts";

describe("absoluteProjectPath", () => {
  it("uses the host separator implied by a Windows root", () => {
    expect(absoluteProjectPath("C:\\Users\\PC\\ppm", "src/a.ts")).toBe("C:\\Users\\PC\\ppm\\src\\a.ts");
    expect(absoluteProjectPath("C:\\Users\\PC\\ppm", "src/components/a.ts"))
      .toBe("C:\\Users\\PC\\ppm\\src\\components\\a.ts");
  });

  it("uses '/' for a POSIX root", () => {
    expect(absoluteProjectPath("/home/pc/ppm", "src/a.ts")).toBe("/home/pc/ppm/src/a.ts");
  });

  it("returns the root unchanged for an empty relative path", () => {
    expect(absoluteProjectPath("C:\\Users\\PC\\ppm", "")).toBe("C:\\Users\\PC\\ppm");
    expect(absoluteProjectPath("/home/pc/ppm", "")).toBe("/home/pc/ppm");
  });

  it("does not double the separator when the root already ends with one", () => {
    expect(absoluteProjectPath("C:\\", "a.ts")).toBe("C:\\a.ts");
    expect(absoluteProjectPath("/", "a.ts")).toBe("/a.ts");
  });

  it("round-trips with relativeProjectPath on a Windows root", () => {
    const root = "C:\\Users\\PC\\ppm";
    const absolute = absoluteProjectPath(root, "src/components/a.ts");
    expect(relativeProjectPath(root, absolute)).toBe("src/components/a.ts");
  });
});
