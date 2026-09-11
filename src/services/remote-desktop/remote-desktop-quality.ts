/**
 * The *policy* over the quality ladder: how far a congested link may pull the bitrate below the
 * rung the user chose, and when it moves. The ladder itself (labels and ratios) is in
 * `src/shared/remote-desktop-quality.ts`, because the client renders it too.
 *
 * The shape of this is RustDesk's, and replacing what was here fixed a reported flicker — but
 * not by the mechanism it first looked like, which is worth writing down because the wrong
 * diagnosis is the plausible one.
 *
 * What the old ladder did was cap *resolution* per rung and hand the top rung a flat 25 Mbit/s
 * at 1440p60. Over a wifi link that cannot carry that, the capture pipe backs up and **ffmpeg
 * throttles itself**: measured at 4 Mbit/s, 22.9 of 60 fps arrived with inter-frame gaps to
 * **181 ms** — bursts and stalls rather than a steady cadence, which at 3440x1440 is exactly
 * what reads as continuous flicker. The same rung on an unthrottled link measured 60.0 fps at
 * `gap p50=16.5 p95=22.8 max=35.7 ms`, so the rung was never the problem; asking for a rate the
 * link could not carry was.
 *
 * The tempting explanation was the frame-dropping path — discarding one delta makes every later
 * delta in its GOP undecodable, so dropping under congestion really would break the picture up
 * continuously. It was **not** what happened: `congestionState` never fired in any of those
 * runs, because `ws.getBufferedAmount()` is Bun's *userspace* queue and it drains into the
 * kernel socket buffer, so it never reached `BACKPRESSURE_THRESHOLD_BYTES`. The keyframe rate
 * gives it away — 0.75/s against a 30-frame GOP is ffmpeg encoding at 22 fps, not a server
 * discarding two thirds of what it encoded.
 *
 * So the measured fix is the ladder: a rung now sets only a bitrate *ratio* against
 * `base_bitrate(w, h)`, which for a 3440x1440 display makes the top rung 6 Mbit/s rather than
 * 25, and the stream holds **30.0 fps with a 42 ms maximum gap over both a 5 Mbit/s and a
 * 2 Mbit/s link**.
 *
 * What is here regardless is RustDesk's own rule, because the old code had a real defect even if
 * it was not the one being reported: choosing a rung used to set `autoQuality = false`, which
 * turned the adaptation off entirely and left frame-dropping as the only remaining response.
 * `video_qos.rs` is explicit that the choice is a *maximum* — "user set image quality => update
 * to the **maximum** ratio of the latest quality" — with the adaptation always running
 * underneath it, and encoded frames never thrown away. It reduces the bitrate ratio first and
 * only then the frame rate, because "bitrate-targeted encoders do not send fewer bytes at fewer
 * frames".
 *
 * Two caveats on `nextRatioScale`, stated rather than implied. It nudges where RustDesk nudges
 * every three seconds: ours cannot, because every bitrate change respawns ffmpeg for ~400 ms, so
 * the same idea is applied in coarse steps behind `CHANGE_COOLDOWN_MS`. And it is **unit-tested
 * only** — no end-to-end run has exercised it, because the detector it hangs off did not fire
 * even at 0.4 Mbit/s with a relay applying real TCP backpressure. If congestion needs to be
 * acted on in practice, the thing to fix first is the *signal*, not this policy.
 */

export {
  DEFAULT_FPS, DEFAULT_PRESET_ID, QUALITY_PRESETS, QUALITY_PRESET_ORDER, parsePresetId,
  type QualityPreset, type QualityPresetId, type QualityRung,
} from "../../shared/remote-desktop-quality.ts";

/** Backpressure events within `DEGRADE_WINDOW_MS` that mean "this link is not keeping up".
 *  One event is a hiccup — a scroll, a video frame, a tunnel reconnect. */
export const DEGRADE_EVENT_THRESHOLD = 3;
export const DEGRADE_WINDOW_MS = 5_000;
/** Quiet stretch before climbing back toward the chosen rung. Long, because the cost of
 *  guessing wrong is a stall and then a second respawn to undo it. */
export const UPGRADE_QUIET_MS = 20_000;
/** Floor between two changes, whichever direction — bounds the respawn hitch to at worst one
 *  per this interval no matter how the link behaves. */
export const CHANGE_COOLDOWN_MS = 10_000;

/** Each reduction multiplies the ratio by this; each recovery divides by it. 0.6 is a third of
 *  the way down per step, so three steps reach the floor — few enough that a genuinely bad link
 *  settles inside a minute, coarse enough that each step is worth a respawn. */
export const CONGESTION_STEP = 0.6;
/** How far below the chosen rung congestion may go. At `balanced` (ratio 0.67) this bottoms out
 *  at 0.13, which `clampRatio` then lifts to RustDesk's own `BR_MIN` of 0.2. */
export const CONGESTION_MIN_SCALE = 0.2;

/** Bytes buffered on the socket above which the link is considered behind. */
export const BACKPRESSURE_THRESHOLD_BYTES = 512 * 1024;
/** How long it must *stay* above that before frames are discarded — see `congestionState`. */
export const BACKPRESSURE_SUSTAIN_MS = 250;

/**
 * Whether the socket is genuinely congested, given how long it has been backed up.
 *
 * Reacting to the first over-threshold frame is strictly counterproductive, and measurably so:
 * discarding one delta makes every later delta in that GOP undecodable, so the client freezes
 * until the next keyframe. A **120 ms** spike bought a **502 ms** frozen picture that way. A
 * spike that short is a client GC pause or a single wifi retransmit — it drains on its own, and
 * riding it out costs only the few hundred KB that keep flowing meanwhile.
 *
 * `since` is the caller's previous value, threaded back in so this stays pure.
 */
export function congestionState(
  since: number | null, buffered: number, now: number,
): { since: number | null; congested: boolean } {
  if (buffered <= BACKPRESSURE_THRESHOLD_BYTES) return { since: null, congested: false };
  const startedAt = since ?? now;
  return { since: startedAt, congested: now - startedAt >= BACKPRESSURE_SUSTAIN_MS };
}

export interface AdaptiveState {
  /** Timestamps of recent backpressure events, pruned to `DEGRADE_WINDOW_MS`. */
  events: number[];
  /** When the bitrate last changed, so a flapping link cannot respawn ffmpeg repeatedly. */
  lastChangeAt: number;
}

export function initialAdaptiveState(now: number): AdaptiveState {
  return { events: [], lastChangeAt: now };
}

/** Record a backpressure event, dropping any older than the window. */
export function noteBackpressure(state: AdaptiveState, now: number): AdaptiveState {
  const events = [...state.events, now].filter((t) => now - t <= DEGRADE_WINDOW_MS);
  return { ...state, events };
}

/**
 * The scale the effective bitrate ratio should be at, or null to stay put. Pure so the whole
 * policy is testable without a socket: `current` is the scale in force (1 = the chosen rung's
 * own ratio, nothing held back), `state` is the session's backpressure history.
 *
 * Never returns above 1: the rung the user picked is the ceiling, and a quiet link is not a
 * reason to spend more than they asked for.
 */
export function nextRatioScale(
  current: number, state: AdaptiveState, now: number,
): number | null {
  if (now - state.lastChangeAt < CHANGE_COOLDOWN_MS) return null;

  const recent = state.events.filter((t) => now - t <= DEGRADE_WINDOW_MS);
  if (recent.length >= DEGRADE_EVENT_THRESHOLD) {
    if (current <= CONGESTION_MIN_SCALE) return null; // already as low as this goes
    return Math.max(CONGESTION_MIN_SCALE, current * CONGESTION_STEP);
  }

  const lastEvent = state.events.length > 0 ? Math.max(...state.events) : null;
  const quietFor = lastEvent === null ? now - state.lastChangeAt : now - lastEvent;
  if (quietFor >= UPGRADE_QUIET_MS && current < 1) {
    return Math.min(1, current / CONGESTION_STEP);
  }
  return null;
}
