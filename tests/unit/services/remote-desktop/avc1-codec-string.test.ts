import { describe, it, expect } from "bun:test";
import { avc1CodecString } from "../../../../src/services/remote-desktop/avc1-codec-string.ts";

describe("avc1CodecString", () => {
  it("derives PPCCLL hex from profile_idc/constraint/level_idc after the NAL header byte", () => {
    // NAL header, then profile_idc=0x64 (High), constraint=0x00, level_idc=0x28 (4.0)
    const sps = Uint8Array.of(0x67, 0x64, 0x00, 0x28, 0xff, 0xff);
    expect(avc1CodecString(sps)).toBe("avc1.640028");
  });

  it("pads single-digit hex values", () => {
    const sps = Uint8Array.of(0x67, 0x0a, 0x00, 0x09);
    expect(avc1CodecString(sps)).toBe("avc1.0a0009");
  });

  it("returns null for an SPS too short to contain profile/level bytes", () => {
    expect(avc1CodecString(Uint8Array.of(0x67, 0x64))).toBeNull();
  });
});
