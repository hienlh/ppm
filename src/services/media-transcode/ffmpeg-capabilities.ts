/**
 * Discover ffmpeg/ffprobe on this machine and pick the fastest working H.264 encoder.
 *
 * ffmpeg is an *optional* dependency: without it PPM still plays browser-native
 * media (mp4/webm) via Range requests, it just cannot transcode AVI/MKV. The
 * result is cached for the process lifetime — the binary does not appear
 * mid-session, and probing hardware encoders costs a real encode each.
 *
 * Hardware encoders are verified by encoding a few synthetic frames rather than by
 * grepping `ffmpeg -encoders`: the list only says the build was compiled with
 * NVENC/QSV support, not that a compatible GPU/driver is present.
 */

export interface FfmpegCapabilities {
  ffmpeg: string | null;
  ffprobe: string | null;
  /** ffmpeg encoder name (`h264_nvenc`, `libx264`…) or null when nothing encodes. */
  encoder: string | null;
}

/** Candidate encoders in preference order; each is test-encoded before being trusted. */
function encoderCandidates(): string[] {
  switch (process.platform) {
    case "win32": return ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
    case "darwin": return ["h264_videotoolbox", "libx264"];
    default: return ["h264_nvenc", "h264_qsv", "libx264"];
  }
}

/** Per-encoder quality/speed flags tuned for "watch a file inside the IDE" latency. */
export function encoderArgs(encoder: string): string[] {
  switch (encoder) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "26", "-b:v", "0"];
    case "h264_qsv": return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "26"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "26"];
    case "h264_videotoolbox": return ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-realtime", "1"];
    default: return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M"];
  }
}

async function encoderWorks(ffmpeg: string, encoder: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        // 256px: hardware encoders reject frames below ~145×49 (NVENC "Frame Dimension less than minimum").
        "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2",
        "-frames:v", "3", "-pix_fmt", "yuv420p", ...encoderArgs(encoder),
        "-f", "null", "-",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    // A hung driver must not stall the whole capability probe.
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

let cached: Promise<FfmpegCapabilities> | null = null;

async function detect(): Promise<FfmpegCapabilities> {
  const ffmpeg = Bun.which("ffmpeg");
  const ffprobe = Bun.which("ffprobe");
  if (!ffmpeg) return { ffmpeg: null, ffprobe, encoder: null };
  for (const candidate of encoderCandidates()) {
    if (await encoderWorks(ffmpeg, candidate)) return { ffmpeg, ffprobe, encoder: candidate };
  }
  return { ffmpeg, ffprobe, encoder: null };
}

/** Cached capability lookup; the first call pays for the encoder probes. */
export function getFfmpegCapabilities(): Promise<FfmpegCapabilities> {
  if (!cached) {
    cached = detect().catch((e) => {
      cached = null; // let a later call retry after an unexpected failure
      throw e;
    });
  }
  return cached;
}

/** Test hook: drop the cache so a different PATH can be probed. */
export function resetFfmpegCapabilitiesCache(): void {
  cached = null;
}
