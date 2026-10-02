import { describe, expect, test } from "bun:test";
import {
  ANDROID_PROTOCOL_VERSION, VIDEO_HEADER_BYTES, decodeVideoFrame, encodeVideoFrame,
} from "../../../src/shared/android-protocol.ts";

describe("android video framing", () => {
  test("round-trips every header field", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x65, 0xde, 0xad]);
    const frame = encodeVideoFrame({
      keyframe: true, codecConfig: false,
      sessionGeneration: 7, geometryGeneration: 3, sequence: 123456, ptsMs: 1234.5,
    }, payload);

    const decoded = decodeVideoFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.header).toEqual({
      version: ANDROID_PROTOCOL_VERSION,
      keyframe: true, codecConfig: false,
      sessionGeneration: 7, geometryGeneration: 3, sequence: 123456, ptsMs: 1234.5,
      payloadLength: payload.length,
    });
    expect([...decoded!.payload]).toEqual([...payload]);
  });

  test("flags are independent", () => {
    const both = decodeVideoFrame(encodeVideoFrame({
      keyframe: true, codecConfig: true, sessionGeneration: 1, geometryGeneration: 1,
      sequence: 0, ptsMs: 0,
    }, new Uint8Array(1)))!;
    expect(both.header.keyframe).toBe(true);
    expect(both.header.codecConfig).toBe(true);

    const neither = decodeVideoFrame(encodeVideoFrame({
      keyframe: false, codecConfig: false, sessionGeneration: 1, geometryGeneration: 1,
      sequence: 0, ptsMs: 0,
    }, new Uint8Array(1)))!;
    expect(neither.header.keyframe).toBe(false);
    expect(neither.header.codecConfig).toBe(false);
  });

  // The whole point of carrying a length a WS frame already implies: a proxy that truncates or
  // coalesces must be detectable, because a short access unit decodes to garbage rather than
  // failing.
  test("rejects a truncated frame instead of decoding garbage", () => {
    const frame = encodeVideoFrame({
      keyframe: true, codecConfig: false, sessionGeneration: 1, geometryGeneration: 1,
      sequence: 0, ptsMs: 0,
    }, new Uint8Array(64));
    expect(decodeVideoFrame(frame.subarray(0, frame.length - 1))).toBeNull();
    expect(decodeVideoFrame(new Uint8Array(VIDEO_HEADER_BYTES - 1))).toBeNull();
  });

  test("a sequence number past 16 bits still round-trips", () => {
    const decoded = decodeVideoFrame(encodeVideoFrame({
      keyframe: false, codecConfig: false, sessionGeneration: 65535, geometryGeneration: 65535,
      sequence: 4_000_000_000, ptsMs: 9_999_999.25,
    }, new Uint8Array(0)))!;
    expect(decoded.header.sequence).toBe(4_000_000_000);
    expect(decoded.header.sessionGeneration).toBe(65535);
    expect(decoded.header.ptsMs).toBe(9_999_999.25);
  });
});
