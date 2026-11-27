/**
 * "The PC can still be reached through PPM", measured instead of asked.
 *
 * After "Bring session back" or "Turn on virtual display" the Windows helper arms a safety net
 * that runs in 5 minutes unless confirmed. It used to ask the user to press "I can still reach this
 * PC", which nobody understood. A picture arriving on this device is that very proof, so the
 * viewer reports it and the gate confirms by itself.
 *
 * The rule: frames have kept arriving for `PROOF_MS` (3 s), with no gap longer than `MAX_GAP_MS`.
 * - Not the first frame: one keyframe proves capture started, not that it holds. A capture on a
 *   session with no real screen can deliver a frame and then die (ffmpeg's "no stream" exit), and
 *   confirming then would take the net down for a PC that is about to be unreachable.
 * - 3 s: long enough that capture, encoder and transport have all run steadily (90 frames at
 *   30 fps), short enough that it happens while the user is still looking at the first picture.
 * - `MAX_GAP_MS` 1.5 s: a still desktop still streams at the capture rate on Windows (gdigrab and
 *   ddagrab emit every tick), so a longer gap means the stream stalled; the clock starts again.
 * Confirming is never less safe than letting the net run: `Confirm` first does what `Rescue` would
 * (turns the virtual display on for a console session with no monitor), then disarms it.
 */
import { createContext, useContext, useEffect, useRef } from "react";

export const PROOF_MS = 3000;
export const MAX_GAP_MS = 1500;
export const SAMPLE_MS = 500;

export interface PictureProofState {
  /** When the current unbroken run of frames began, or null when there is none. */
  runStartMs: number | null;
  /** When a new frame was last seen. */
  lastFrameMs: number;
  lastCount: number;
}

export const NO_PICTURE: PictureProofState = { runStartMs: null, lastFrameMs: 0, lastCount: 0 };

/** One sample of the decoder's frame counter → the next state, and whether the picture is proven. Pure. */
export function samplePicture(state: PictureProofState, streaming: boolean, frameCount: number, nowMs: number): {
  state: PictureProofState;
  proven: boolean;
} {
  if (!streaming) return { state: { ...NO_PICTURE, lastCount: frameCount }, proven: false };
  // A reconnect resets the decoder's counter: start counting again from there.
  const reset = frameCount < state.lastCount;
  const gotFrame = frameCount > (reset ? 0 : state.lastCount);
  if (!gotFrame) {
    const stalled = state.runStartMs !== null && nowMs - state.lastFrameMs > MAX_GAP_MS;
    const next = stalled || reset ? { ...NO_PICTURE, lastCount: frameCount } : state;
    return { state: next, proven: spansProof(next) };
  }
  const continuing = state.runStartMs !== null && !reset && nowMs - state.lastFrameMs <= MAX_GAP_MS;
  const next = { runStartMs: continuing ? state.runStartMs! : nowMs, lastFrameMs: nowMs, lastCount: frameCount };
  return { state: next, proven: spansProof(next) };
}

/** Measured between frames actually seen, never by the clock alone: a quiet second inside the
 *  allowed gap must not count toward the proof. */
function spansProof(state: PictureProofState): boolean {
  return state.runStartMs !== null && state.lastFrameMs - state.runStartMs >= PROOF_MS;
}

/** The gate's ear: a viewer tells it whether a picture is currently proven. */
export const PictureProofContext = createContext<(proven: boolean) => void>(() => {});

/** Used by each viewer (desktop window and phone sheet): samples the frame counter while
 *  streaming and reports to the gate whenever "proven" changes. */
export function usePictureProof(streaming: boolean, getFrameCount: () => number): void {
  const report = useContext(PictureProofContext);
  // The getter is read through a ref: the WebRTC path hands out a new function each render, and
  // restarting the sampler on every render would never let a run reach `PROOF_MS`.
  const getter = useRef(getFrameCount);
  getter.current = getFrameCount;
  useEffect(() => {
    let state = NO_PICTURE;
    let proven = false;
    const tick = () => {
      const r = samplePicture(state, streaming, getter.current(), performance.now());
      state = r.state;
      if (r.proven !== proven) { proven = r.proven; report(proven); }
    };
    tick();
    const timer = setInterval(tick, SAMPLE_MS);
    return () => { clearInterval(timer); if (proven) report(false); };
  }, [streaming, report]);
}
