import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatSeconds, ranOnText, speedup, TEST_SAMPLE_URL } from "../../../src/web/lib/whisper-test-client";

describe("formatSeconds", () => {
  it("keeps two significant figures", () => {
    expect(formatSeconds(835)).toBe("0.83 s");
    expect(formatSeconds(5347)).toBe("5.3 s");
    expect(formatSeconds(11_880)).toBe("12 s");
  });
});

describe("speedup", () => {
  it("says how much faster the GPU run was, and nothing when it was not", () => {
    expect(speedup(835, 5347)).toBe("6.4× faster on the GPU");
    expect(speedup(100, 5000)).toBe("50× faster on the GPU");
    expect(speedup(5000, 4000)).toBeNull();
    expect(speedup(0, 4000)).toBeNull();
  });
});

describe("ranOnText", () => {
  const base = { text: "x", ms: 1, model: "Large v3 Turbo", device: null };
  it("names the card and the API for a GPU run", () => {
    expect(ranOnText({ ...base, ranOn: "gpu", backend: "cuda", device: "NVIDIA GeForce RTX 4070" }))
      .toBe("GPU — NVIDIA GeForce RTX 4070 (CUDA) · Large v3 Turbo");
    expect(ranOnText({ ...base, ranOn: "gpu", backend: "metal", device: "Apple M2 Pro" }))
      .toBe("GPU — Apple M2 Pro (Metal) · Large v3 Turbo");
  });
  it("says the CPU, and why when the GPU failed", () => {
    expect(ranOnText({ ...base, ranOn: "cpu", backend: "cuda" })).toBe("CPU · Large v3 Turbo");
    expect(ranOnText({ ...base, ranOn: "cpu", backend: "cuda", fellBack: true })).toContain("the GPU failed");
  });
});

describe("the bundled sample", () => {
  it("is whisper.cpp's samples/jfk.mp3 at the pinned release, byte for byte", () => {
    const file = resolve(import.meta.dir, "../../../src/web/public", TEST_SAMPLE_URL.slice(1));
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(sha).toBe("20d3323a2bcce6f25498b8911a397503a0a99fa92b6ba58d62788cb42b6e5459");
  });
});
