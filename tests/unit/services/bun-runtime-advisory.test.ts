import { describe, it, expect } from "bun:test";
import { bunRuntimeAdvisory } from "../../../src/services/bun-runtime-advisory.ts";

describe("bunRuntimeAdvisory", () => {
  it("warns on the Windows releases that also leak thread handles, and says how to fix it", () => {
    const text = bunRuntimeAdvisory("1.3.10", "win32");
    expect(text).toContain("Bun 1.3.10");
    expect(text).toContain("thread handle");
    expect(text).toContain("bun upgrade");
    expect(text).toContain("1.4.4");
    for (const v of ["1.2.23", "1.3.9"]) expect(bunRuntimeAdvisory(v, "win32")).toContain("thread handle");
  });

  it("warns on the Windows releases measured (or not yet measured) to keep 32 MB blocks", () => {
    // 1.3.12 measured on 23/11/2026: supervisor +150 MB/h, edge +236 MB/h, server +108 MB/h.
    for (const v of ["1.3.11", "1.3.12", "1.3.13", "1.3.14", "1.4.0", "1.4.3"]) {
      const text = bunRuntimeAdvisory(v, "win32");
      expect(text).toContain("32 MB");
      expect(text).not.toContain("thread handle");
      expect(text).toContain("bun upgrade");
    }
  });

  it("stays quiet on the releases measured clean, and later ones", () => {
    for (const v of ["1.4.4", "1.4.5", "1.5.0"]) expect(bunRuntimeAdvisory(v, "win32")).toBeNull();
  });

  it("stays quiet on other platforms, where neither leak was measured", () => {
    for (const v of ["1.3.10", "1.3.12"]) {
      expect(bunRuntimeAdvisory(v, "linux")).toBeNull();
      expect(bunRuntimeAdvisory(v, "darwin")).toBeNull();
    }
  });
});
