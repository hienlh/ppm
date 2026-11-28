/** The phone viewer's pointer size: three sizes, Small (the old fixed 14px) by default, and a
 *  stored value read back from localStorage never trusted as-is. */
import { describe, expect, it } from "bun:test";
import { CURSOR_SIZES, CURSOR_SIZE_PX, parseCursorSize } from "../../../src/web/components/remote-desktop/remote-desktop-cursor-size.ts";

describe("remote desktop cursor size", () => {
  it("offers three sizes, growing, with Small the size the marker always had", () => {
    expect(CURSOR_SIZES.map((s) => s.id)).toEqual(["small", "medium", "large"]);
    expect(CURSOR_SIZE_PX.small).toBe(14);
    expect(CURSOR_SIZE_PX.small).toBeLessThan(CURSOR_SIZE_PX.medium);
    expect(CURSOR_SIZE_PX.medium).toBeLessThan(CURSOR_SIZE_PX.large);
  });

  it("reads back a stored size, and anything else as Small", () => {
    expect(parseCursorSize("large")).toBe("large");
    expect(parseCursorSize("medium")).toBe("medium");
    for (const bad of [undefined, null, "huge", 32, {}]) expect(parseCursorSize(bad)).toBe("small");
  });
});
