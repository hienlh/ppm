import { describe, expect, it } from "bun:test";
import { isWav, toWhisperWav, wavDurationSec } from "../../../../src/services/voice-message/voice-audio.ts";

/** A PCM WAV header plus `dataBytes` of silence, with extra chunks before `data` like real recorders write. */
function wav(dataBytes: number, byteRate = 32_000, withList = false): Uint8Array {
  const list = withList ? 12 : 0;
  const buf = new Uint8Array(44 + list + dataBytes);
  const view = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => { buf[at + i] = ch.charCodeAt(0); });
  put(0, "RIFF"); view.setUint32(4, buf.length - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, byteRate, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  let at = 36;
  if (withList) { put(at, "LIST"); view.setUint32(at + 4, 4, true); put(at + 8, "INFO"); at += 12; }
  put(at, "data"); view.setUint32(at + 4, dataBytes, true);
  return buf;
}

describe("isWav", () => {
  it("recognises RIFF/WAVE and nothing else", () => {
    expect(isWav(wav(10))).toBe(true);
    expect(isWav(new TextEncoder().encode("OggS\0\0\0\0\0\0\0\0\0\0"))).toBe(false);
    expect(isWav(new Uint8Array(4))).toBe(false);
  });
});

describe("wavDurationSec", () => {
  it("divides the data size by the byte rate, past other chunks", () => {
    expect(wavDurationSec(wav(64_000))).toBe(2);
    expect(wavDurationSec(wav(32_000, 32_000, true))).toBe(1);
  });

  it("trusts the bytes present over a header that claims more", () => {
    const w = wav(32_000);
    new DataView(w.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDurationSec(w)).toBe(1);
  });

  it("answers null without a usable fmt or data chunk", () => {
    expect(wavDurationSec(wav(10, 0))).toBeNull();
    expect(wavDurationSec(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("toWhisperWav", () => {
  it("passes a WAV through untouched, never needing ffmpeg", async () => {
    const w = wav(100);
    expect(await toWhisperWav(w)).toBe(w);
  });
});
