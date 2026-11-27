import { describe, expect, it } from "bun:test";
import {
  MAX_GAP_MS, NO_PICTURE, PROOF_MS, SAMPLE_MS, samplePicture, type PictureProofState,
} from "../../../src/web/components/remote-desktop/use-picture-proof.ts";
import { RESCUE_MINUTES_SHOWN } from "../../../src/web/components/remote-desktop/remote-desktop-rescue-notice.tsx";
import { RESCUE_MINUTES } from "../../../src/services/remote-desktop/win32-helper/helper-paths.ts";

/** Feeds samples every `SAMPLE_MS` with `framesPerSample` new frames; returns when it was proven. */
function run(samples: number[], streaming = true, start: PictureProofState = NO_PICTURE) {
  let state = start;
  const proven: boolean[] = [];
  let count = state.lastCount;
  samples.forEach((add, i) => {
    count += add;
    const r = samplePicture(state, streaming, count, i * SAMPLE_MS);
    state = r.state;
    proven.push(r.proven);
  });
  return { state, proven };
}

describe("samplePicture", () => {
  it("is not proven by the first frame, only after frames kept coming for the whole window", () => {
    const steps = PROOF_MS / SAMPLE_MS;
    const { proven } = run(Array(steps + 1).fill(15));
    expect(proven[0]).toBe(false);
    expect(proven.slice(0, steps).every((p) => !p)).toBe(true);
    expect(proven[steps]).toBe(true);
  });

  it("starts the clock again after a gap longer than MAX_GAP_MS", () => {
    const gapSamples = Math.ceil(MAX_GAP_MS / SAMPLE_MS) + 1;
    const steps = PROOF_MS / SAMPLE_MS;
    // 2.5 s of frames, a stall, then frames again: the 2.5 s do not count.
    const { proven } = run([...Array(steps).fill(15), ...Array(gapSamples).fill(0), ...Array(steps).fill(15)]);
    expect(proven.some((p) => p)).toBe(false);
  });

  it("tolerates a short gap inside the run", () => {
    const steps = PROOF_MS / SAMPLE_MS;
    const { proven } = run([15, 15, 0, 15, 15, 15, 15, 15]);
    expect(proven[steps]).toBe(true);
  });

  it("is never proven while not streaming, however many frames were counted", () => {
    const { proven } = run(Array(20).fill(15), false);
    expect(proven.some((p) => p)).toBe(false);
  });

  it("a reconnect (the counter going back down) starts again from zero", () => {
    const proven1 = run(Array(10).fill(15));
    expect(proven1.proven.at(-1)).toBe(true);
    // The decoder was recreated: its counter restarts below the last value seen.
    const r = samplePicture(proven1.state, true, 3, 10 * SAMPLE_MS);
    expect(r.proven).toBe(false);
  });
});

describe("the notice and the helper agree on the minutes", () => {
  it("names the helper's own RESCUE_MINUTES", () => {
    expect(RESCUE_MINUTES_SHOWN).toBe(RESCUE_MINUTES);
  });
});
