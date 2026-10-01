import { describe, it, expect } from "bun:test";
import { encodeWavPcm16, mixToMono } from "../../../src/web/lib/voice-wav.ts";

/** Reads the fields whisper.cpp's decoder cares about back out of the header. */
function header(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...wav.slice(offset, offset + length));
  return {
    riff: text(0, 4),
    wave: text(8, 4),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
    riffSize: view.getUint32(4, true),
  };
}

describe("encodeWavPcm16", () => {
  it("writes a 16 kHz mono 16-bit PCM header", () => {
    const wav = encodeWavPcm16(new Float32Array(160), 16_000);
    expect(header(wav)).toEqual({
      riff: "RIFF",
      wave: "WAVE",
      format: 1,
      channels: 1,
      sampleRate: 16_000,
      byteRate: 32_000,
      blockAlign: 2,
      bitsPerSample: 16,
      dataSize: 320,
      riffSize: 356,
    });
    expect(wav.byteLength).toBe(44 + 320);
  });

  it("keeps the sample rate it is given", () => {
    // A browser that declines to resample during decode must still produce a
    // file that says what it actually contains.
    expect(header(encodeWavPcm16(new Float32Array(10), 48_000)).sampleRate).toBe(48_000);
  });

  it("converts samples to signed 16-bit and clamps out-of-range values", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 2, -2]), 16_000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const at = (i: number) => view.getInt16(44 + i * 2, true);

    expect(at(0)).toBe(0);
    expect(at(1)).toBe(16383);
    expect(at(2)).toBe(-16384);
    expect(at(3)).toBe(32767);
    expect(at(4)).toBe(-32768);
  });
});

describe("mixToMono", () => {
  it("returns the single channel untouched", () => {
    const only = new Float32Array([0.1, 0.2]);
    expect(mixToMono([only])).toBe(only);
  });

  it("averages the channels", () => {
    const mixed = mixToMono([new Float32Array([1, 0, -1]), new Float32Array([0, 0.5, 1])]);
    expect(Array.from(mixed)).toEqual([0.5, 0.25, 0]);
  });

  it("handles no channels at all", () => {
    expect(mixToMono([]).length).toBe(0);
  });
});
