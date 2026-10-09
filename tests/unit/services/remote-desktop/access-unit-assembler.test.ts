import { describe, it, expect } from "bun:test";
import { AccessUnitAssembler } from "../../../../src/services/remote-desktop/access-unit-assembler.ts";
import { nalType, NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR, NAL_TYPE_SLICE_NON_IDR } from "../../../../src/services/remote-desktop/nal-splitter.ts";

/** Build an Annex-B byte blob from NAL type bytes (each NAL here is just its header byte
 *  followed by a couple of filler bytes — enough for start-code parsing + type classification,
 *  which is all the assembler reads).
 *
 *  Note: Annex-B has no length prefix, so both the splitter and the assembler only confirm a
 *  unit as "done" once the *next* one starts — an access unit only flushes once its trailing
 *  VCL NAL has itself been superseded by a further VCL NAL. Every fixture below therefore ends
 *  with one extra trailing NAL purely to trigger that final flush; it is not itself asserted on. */
function annexB(...nalHeaders: number[]): Uint8Array {
  const parts: number[] = [];
  for (const header of nalHeaders) {
    parts.push(0, 0, 0, 1, header, 0xaa, 0xbb, 0xcc);
  }
  return new Uint8Array(parts);
}

describe("AccessUnitAssembler", () => {
  it("groups SPS+PPS+IDR into one keyframe access unit", () => {
    const asm = new AccessUnitAssembler();
    // SPS, PPS, IDR (the AU under test), then two more slices purely to push it out the door.
    const aus = asm.push(annexB(NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR, NAL_TYPE_SLICE_NON_IDR, NAL_TYPE_SLICE_NON_IDR));
    expect(aus.length).toBe(1);
    expect(aus[0]!.isKey).toBe(true);
    expect(extractNalTypes(aus[0]!.bytes)).toEqual([NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR]);
  });

  it("classifies a lone slice NAL as a delta access unit", () => {
    const asm = new AccessUnitAssembler();
    const aus = asm.push(annexB(
      NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR,
      NAL_TYPE_SLICE_NON_IDR, NAL_TYPE_SLICE_NON_IDR, NAL_TYPE_SLICE_NON_IDR,
    ));
    expect(aus.length).toBe(2);
    expect(aus[0]!.isKey).toBe(true);
    expect(aus[1]!.isKey).toBe(false);
    expect(extractNalTypes(aus[1]!.bytes)).toEqual([NAL_TYPE_SLICE_NON_IDR]);
  });

  it("handles a NAL split mid-payload across two push() calls", () => {
    const asm = new AccessUnitAssembler();
    const whole = annexB(NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR, NAL_TYPE_SLICE_NON_IDR, NAL_TYPE_SLICE_NON_IDR);
    // Each NAL here is 8 bytes (4-byte start code + 4-byte payload); split at byte 22, which
    // lands 2 bytes into the 3rd NAL's payload (IDR, at [16,24)) — a genuine mid-NAL cut, not
    // a clean boundary between NALs.
    const firstAus = asm.push(whole.slice(0, 22));
    const secondAus = asm.push(whole.slice(22));
    const all = [...firstAus, ...secondAus];
    expect(all.length).toBe(1);
    expect(all[0]!.isKey).toBe(true);
    expect(extractNalTypes(all[0]!.bytes)).toEqual([NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR]);
  });

  it("keeps every slice of a frame in that frame's access unit", () => {
    // x264 under `tune=zerolatency` cuts each frame into one slice per thread, and only the
    // first names macroblock 0. Cutting at every slice sent each one to the decoder as a frame
    // of its own, which decoded to nothing at all (#48).
    const asm = new AccessUnitAssembler();
    const aus = asm.push(slices(
      [NAL_TYPE_SPS, 0], [NAL_TYPE_PPS, 0],
      [NAL_TYPE_IDR, 0], [NAL_TYPE_IDR, 1], [NAL_TYPE_IDR, 2],
      [NAL_TYPE_SLICE_NON_IDR, 0], [NAL_TYPE_SLICE_NON_IDR, 1],
      // Not asserted on: the splitter releases a NAL only once the next one starts, and the
      // assembler a picture only once the next one opens — so two more pictures push it out.
      [NAL_TYPE_SLICE_NON_IDR, 0], [NAL_TYPE_SLICE_NON_IDR, 0],
    ));
    expect(aus.length).toBe(2);
    expect(aus[0]!.isKey).toBe(true);
    expect(extractNalTypes(aus[0]!.bytes)).toEqual([NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR, NAL_TYPE_IDR, NAL_TYPE_IDR]);
    expect(aus[1]!.isKey).toBe(false);
    expect(extractNalTypes(aus[1]!.bytes)).toEqual([NAL_TYPE_SLICE_NON_IDR, NAL_TYPE_SLICE_NON_IDR]);
  });

  it("caches SPS for codec-string derivation even before the first AU flushes", () => {
    const asm = new AccessUnitAssembler();
    asm.push(annexB(NAL_TYPE_SPS, NAL_TYPE_PPS, NAL_TYPE_IDR));
    const sps = asm.cachedSps();
    expect(sps).not.toBeNull();
    expect(nalType(sps!)).toBe(NAL_TYPE_SPS);
  });
});

/** Annex-B from `[nalType, firstMb]` pairs. The byte after the header is where a slice's
 *  first_mb_in_slice starts, Exp-Golomb coded: 0 is `1`, 1 is `010`, 2 is `011`. */
function slices(...units: [number, 0 | 1 | 2][]): Uint8Array {
  const firstMbByte = [0x88, 0x48, 0x68];
  return new Uint8Array(units.flatMap(([type, firstMb]) => [0, 0, 0, 1, type, firstMbByte[firstMb]!, 0xbb, 0xcc]));
}

function extractNalTypes(bytes: Uint8Array): number[] {
  const types: number[] = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      types.push(bytes[i + 4]! & 0x1f);
    }
  }
  return types;
}
