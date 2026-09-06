/**
 * Capture-tuned libx264 args — deliberately NOT `encoderArgs()` from `ffmpeg-capabilities.ts`.
 * That table is tuned for "watch a file" (nvenc VBR, libx264 `-crf 23 -maxrate 8M -bufsize
 * 16M`), which fights a real-time capture: large bufsize/VBR inflates latency spikes exactly
 * where `-tune zerolatency` is trying to remove them.
 *
 * libx264 is forced (never the hardware picks from `ffmpeg-capabilities.ts`) so profile/level
 * behavior is deterministic across machines — the actual codec string is still derived from
 * the real SPS bytes at runtime (`avc1-codec-string.ts`), this just keeps that derivation
 * predictable during development.
 */

/** Keyframe interval in frames — `-framerate 15` below means every ~2s, bounding how long a
 *  dropped/late-joining client waits to resync (see WS backpressure handling). */
export const CAPTURE_GOP_FRAMES = 30;
export const CAPTURE_FRAMERATE = 15;

/** ffmpeg output args for the H.264 encode step (goes after `-i desktop -vf ...`). */
export function captureEncoderArgs(): string[] {
  return [
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "main",
    "-level", "4.0",
    "-bf", "0",
    // `-tune zerolatency` turns on x264's sliced-threads, which splits one picture into
    // multiple slice NALs. access-unit-assembler.ts treats every VCL NAL as a new AU
    // boundary (true for one-slice-per-frame libx264 output), so multi-slice pictures would
    // get chopped into partial-picture "access units" WebCodecs can't decode. Force back to
    // one slice per frame so that assumption holds.
    "-x264-params", "sliced-threads=0:slices=1",
    "-b:v", "4M", "-maxrate", "4M", "-bufsize", "2M",
    "-g", String(CAPTURE_GOP_FRAMES),
    "-pix_fmt", "yuv420p",
  ];
}
