import { describe, it, expect } from "bun:test";
import { resolveEntryMode } from "../../../src/index.ts";

describe("resolveEntryMode — binary daemon sentinel routing", () => {
  it("routes __supervise__ to the supervisor daemon", () => {
    expect(resolveEntryMode(["/opt/ppm/bin/ppm", "__supervise__", "8080", "0.0.0.0"])).toBe("supervise");
  });
  it("routes __serve__ to the server daemon", () => {
    expect(resolveEntryMode(["/opt/ppm/bin/ppm", "__serve__", "8080", "0.0.0.0"])).toBe("serve");
  });
  it("routes __edge__ to the edge forwarder", () => {
    expect(resolveEntryMode(["/opt/ppm/bin/ppm", "__edge__", "3214", "0.0.0.0"])).toBe("edge");
  });
  it("treats normal CLI commands as cli", () => {
    expect(resolveEntryMode(["ppm", "start"])).toBe("cli");
    expect(resolveEntryMode(["ppm", "upgrade", "--check"])).toBe("cli");
    expect(resolveEntryMode(["ppm"])).toBe("cli");
  });
  it("prefers supervise when both sentinels somehow present", () => {
    expect(resolveEntryMode(["ppm", "__supervise__", "__serve__"])).toBe("supervise");
    expect(resolveEntryMode(["ppm", "__serve__", "__edge__"])).toBe("serve");
  });
});
