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

/** 30fps + a 1s keyframe interval (30 frames): smoother than 15fps and bounds how long a
 *  dropped/late-joining client waits to resync (see WS backpressure handling). */
export const CAPTURE_FRAMERATE = 30;
export const CAPTURE_GOP_FRAMES = 30;

/** ffmpeg output args for the H.264 encode step (goes after `-i desktop -vf ...`).
 *  Prefers hardware NVENC (verified to work even under an RDP session on this class of GPU) —
 *  hardware encode adds ~5–15ms vs 30–100ms for libx264, the dominant slice of the felt lag on
 *  a fast/LAN transport. Falls back to a low-latency libx264 profile when no hardware H.264
 *  encoder is available. The avc1 codec string is derived from the real SPS at runtime, so the
 *  encoder's actual profile/level is handled regardless of which branch runs. */
export function captureEncoderArgs(encoder: string = "libx264"): string[] {
  const common = ["-b:v", "6M", "-maxrate", "6M", "-g", String(CAPTURE_GOP_FRAMES), "-bf", "0", "-pix_fmt", "yuv420p"];
  switch (encoder) {
    case "h264_nvenc":
      // p2 + `-tune ll` (low latency), CBR, no frame reordering, minimal output delay/VBV.
      return ["-c:v", "h264_nvenc", "-preset", "p2", "-tune", "ll", "-rc", "cbr",
        "-zerolatency", "1", "-delay", "0", "-bufsize", "512k", ...common];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-low_power", "1", "-bufsize", "512k", ...common];
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cbr", "-bufsize", "512k", ...common];
    case "h264_videotoolbox":
      // macOS hardware encode. `-realtime 1` asks VT to hit the deadline over quality,
      // `-prio_speed 1` likewise; `-allow_sw 1` keeps it working on hosts where the hardware
      // encoder is busy/unavailable rather than failing the session. Verified on macOS 26:
      // emits SPS/PPS/SEI before every IDR and one slice per frame, so the AU assembler's
      // assumptions hold unchanged.
      return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-prio_speed", "1", "-allow_sw", "1", ...common];
    default:
      // libx264 low-latency. `-tune zerolatency` enables sliced-threads (multi-slice NALs);
      // access-unit-assembler.ts assumes one slice/frame, so force it back with sliced-threads=0.
      return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "main", "-level", "4.0", "-x264-params", "sliced-threads=0:slices=1",
        "-bufsize", "1M", ...common];
  }
}
