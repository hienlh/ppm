import { describe, it, expect } from "bun:test";
import { NalSplitter, nalType, NAL_TYPE_SPS, NAL_TYPE_IDR, NAL_TYPE_PPS } from "../../../../src/services/remote-desktop/nal-splitter.ts";

describe("NalSplitter", () => {
  it("splits 4-byte start codes and strips them from the payload", () => {
    const splitter = new NalSplitter();
    // A NAL is only confirmed complete once the *next* start code appears (Annex-B has no
    // length prefix), so a trailing PPS marker is appended purely to flush the IDR NAL —
    // it is not itself asserted on here.
    const buf = Uint8Array.of(
      0, 0, 0, 1, NAL_TYPE_SPS, 0xaa,
      0, 0, 0, 1, NAL_TYPE_IDR, 0xbb,
      0, 0, 0, 1, NAL_TYPE_PPS,
    );
    const nals = splitter.push(buf);
    expect(nals.length).toBe(2);
    expect(nalType(nals[0]!)).toBe(NAL_TYPE_SPS);
    expect(Array.from(nals[0]!)).toEqual([NAL_TYPE_SPS, 0xaa]);
    expect(nalType(nals[1]!)).toBe(NAL_TYPE_IDR);
    expect(Array.from(nals[1]!)).toEqual([NAL_TYPE_IDR, 0xbb]);
  });

  it("splits the 3-byte start-code form too", () => {
    const splitter = new NalSplitter();
    const buf = Uint8Array.of(
      0, 0, 1, NAL_TYPE_SPS, 0xaa,
      0, 0, 1, NAL_TYPE_IDR, 0xbb,
      0, 0, 1, NAL_TYPE_PPS,
    );
    const nals = splitter.push(buf);
    expect(nals.length).toBe(2);
    expect(nalType(nals[0]!)).toBe(NAL_TYPE_SPS);
    expect(nalType(nals[1]!)).toBe(NAL_TYPE_IDR);
  });

  it("holds an incomplete trailing NAL until the next push() completes it", () => {
    const splitter = new NalSplitter();
    const first = splitter.push(Uint8Array.of(0, 0, 0, 1, NAL_TYPE_SPS, 0xaa, 0xbb));
    expect(first.length).toBe(0); // no next start code yet — nothing to flush
    const second = splitter.push(Uint8Array.of(0xcc, 0, 0, 0, 1, NAL_TYPE_IDR, 0xdd));
    expect(second.length).toBe(1);
    expect(nalType(second[0]!)).toBe(NAL_TYPE_SPS);
    expect(Array.from(second[0]!)).toEqual([NAL_TYPE_SPS, 0xaa, 0xbb, 0xcc]);
  });

  it("does not leak a following 4-byte start code's leading zero into the payload", () => {
    // Same NAL, but the byte immediately preceding it happens to be zero (a real
    // trailing_zero_8bits scenario, or simply a payload that legitimately ends in 0x00).
    const splitter = new NalSplitter();
    const buf = Uint8Array.of(
      0, 0, 0, 1, NAL_TYPE_SPS, 0x00, 0xaa,
      0, 0, 0, 1, NAL_TYPE_PPS,
    );
    const nals = splitter.push(buf);
    expect(nals.length).toBe(1);
    expect(Array.from(nals[0]!)).toEqual([NAL_TYPE_SPS, 0x00, 0xaa]);
  });
});
