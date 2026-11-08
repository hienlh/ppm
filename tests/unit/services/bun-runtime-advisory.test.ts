import { describe, it, expect } from "bun:test";
import { bunRuntimeAdvisory } from "../../../src/services/bun-runtime-advisory.ts";

describe("bunRuntimeAdvisory", () => {
  it("warns on the Windows releases measured to leak, and says how to fix it", () => {
    const text = bunRuntimeAdvisory("1.3.10", "win32");
    expect(text).toContain("Bun 1.3.10");
    expect(text).toContain("bun upgrade");
    for (const v of ["1.2.23", "1.3.9"]) expect(bunRuntimeAdvisory(v, "win32")).not.toBeNull();
  });

  it("stays quiet on the releases measured clean", () => {
    for (const v of ["1.3.11", "1.3.13", "1.3.14", "1.4.0", "1.4.4"]) expect(bunRuntimeAdvisory(v, "win32")).toBeNull();
  });

  it("stays quiet on other platforms, where 1.3.10 was never measured to leak", () => {
    expect(bunRuntimeAdvisory("1.3.10", "linux")).toBeNull();
    expect(bunRuntimeAdvisory("1.3.10", "darwin")).toBeNull();
  });
});
