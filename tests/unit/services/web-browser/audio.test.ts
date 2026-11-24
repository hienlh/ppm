import { describe, expect, test } from "bun:test";
import { audioTapSource } from "../../../../src/services/web-browser/audio/audio-tap-script.ts";
import { nextStartTime, pcm16ToChannels } from "../../../../src/web/lib/web-browser/pcm-audio-player.ts";

describe("audio tap script", () => {
  test("is one self-contained expression that parses", () => {
    const src = audioTapSource("__ppmAudio_abc");
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('"__ppmAudio_abc"');
  });

  test("does nothing on a page without its binding", () => {
    // No `window` here: the script must bail out before touching any page API.
    const g = globalThis as Record<string, unknown>;
    const hadWindow = "window" in g;
    if (!hadWindow) g.window = {};
    try {
      expect(() => new Function(audioTapSource("__missing"))()).not.toThrow();
    } finally {
      if (!hadWindow) delete g.window;
    }
  });
});

describe("pcm audio player", () => {
  test("splits interleaved int16 into float channels", () => {
    const bytes = new Uint8Array(new Int16Array([16384, -16384, 32767, 0]).buffer);
    const [l, r] = pcm16ToChannels(bytes, 2);
    expect([...l!]).toEqual([0.5, 32767 / 32768]);
    expect([...r!]).toEqual([-0.5, 0]);
  });

  test("keeps the play head a little ahead, and resyncs when it falls behind or drifts far", () => {
    expect(nextStartTime(10, 0)).toBeCloseTo(10.12);
    expect(nextStartTime(10, 10.3)).toBe(10.3);
    expect(nextStartTime(10, 12)).toBeCloseTo(10.12);
  });
});
