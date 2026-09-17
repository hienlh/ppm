/**
 * Discover ffmpeg/ffprobe on this machine and pick the fastest working H.264 encoder.
 *
 * ffmpeg is an *optional* dependency: without it PPM still plays browser-native
 * media (mp4/webm) via Range requests, it just cannot transcode AVI/MKV. A
 * positive result is cached for the process lifetime — probing hardware encoders
 * costs a real encode each. A *negative* result is not: the remote-desktop
 * checklist tells the user to install ffmpeg and promises to notice, so "not
 * found" is re-checked on every call (one `which` + a few `stat`s).
 *
 * `PATH` alone is not enough to find it. A daemon started by launchd inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew's `/opt/homebrew/bin` is not on it —
 * so the well-known install directories are probed after `Bun.which`.
 *
 * Hardware encoders are verified by encoding a few synthetic frames rather than by
 * grepping `ffmpeg -encoders`: the list only says the build was compiled with
 * NVENC/QSV support, not that a compatible GPU/driver is present.
 */
import { readdirSync } from "node:fs";

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
    // VAAPI sits after QSV (Intel does better through QSV) but before libx264, because it is
    // the only hardware H.264 path an AMD Linux host has — `h264_amf` is Windows-only, so
    // without VAAPI every Radeon machine fell all the way back to software encoding.
    default: return ["h264_nvenc", "h264_qsv", "h264_vaapi", "libx264"];
  }
}

/** The DRM render node VAAPI should use, or null when the host exposes none (no GPU driver,
 *  a container without `/dev/dri`). Picks the lowest `renderD*` rather than hardcoding
 *  `renderD128`: it is only the first node by convention and a host whose first GPU is not
 *  render-capable starts at `renderD129`. */
function vaapiRenderNode(): string | null {
  try {
    const nodes = readdirSync("/dev/dri").filter((n) => n.startsWith("renderD")).sort();
    return nodes[0] ? `/dev/dri/${nodes[0]}` : null;
  } catch {
    return null;
  }
}

/** Args VAAPI needs *before* `-i` (it opens the device during input setup), empty for every
 *  other encoder. Separate from `encoderArgs` because argv position matters here. */
export function encoderDeviceArgs(encoder: string): string[] {
  if (encoder !== "h264_vaapi") return [];
  const node = vaapiRenderNode();
  return node ? ["-vaapi_device", node] : [];
}

/** VAAPI encodes from GPU-resident frames, so the chain has to convert and upload first.
 *  Callers that build their own `-vf` must append this rather than passing a second `-vf`. */
export const VAAPI_UPLOAD_FILTER = "format=nv12,hwupload";

/** Per-encoder quality/speed flags tuned for "watch a file inside the IDE" latency. */
export function encoderArgs(encoder: string): string[] {
  switch (encoder) {
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "26", "-b:v", "0"];
    case "h264_qsv": return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "26"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "26"];
    case "h264_videotoolbox": return ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-realtime", "1"];
    // No `-crf`/`-global_quality`: VAAPI's rate control is `-qp` on this encoder.
    case "h264_vaapi": return ["-c:v", "h264_vaapi", "-qp", "26"];
    default: return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "8M", "-bufsize", "16M"];
  }
}

async function encoderWorks(ffmpeg: string, encoder: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
        // 256px: hardware encoders reject frames below ~145×49 (NVENC "Frame Dimension less than minimum").
        ...encoderDeviceArgs(encoder),
        "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30:d=0.2",
        "-frames:v", "3",
        // VAAPI wants hardware frames and rejects a software `-pix_fmt` on the output.
        ...(encoder === "h264_vaapi" ? ["-vf", VAAPI_UPLOAD_FILTER] : ["-pix_fmt", "yuv420p"]),
        ...encoderArgs(encoder),
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

/** Where package managers put ffmpeg when it is not on the daemon's PATH. */
function wellKnownBinDirs(): string[] {
  switch (process.platform) {
    case "darwin": return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    case "win32": {
      const local = process.env.LOCALAPPDATA;
      return [
        ...(local ? [`${local}\\Microsoft\\WinGet\\Links`] : []),
        "C:\\ProgramData\\chocolatey\\bin", "C:\\ffmpeg\\bin",
      ];
    }
    default: return ["/usr/local/bin", "/usr/bin", "/snap/bin", `${process.env.HOME ?? ""}/.local/bin`];
  }
}

/** `Bun.which` on `searchPath` (the process PATH by default) first, then the well-known
 *  directories. Exported for tests. */
export function findFfmpegBinary(
  name: "ffmpeg" | "ffprobe",
  dirs: string[] = wellKnownBinDirs(),
  searchPath: string | undefined = process.env.PATH,
): string | null {
  const onPath = Bun.which(name, searchPath ? { PATH: searchPath } : undefined);
  if (onPath) return onPath;
  for (const dir of dirs) {
    const found = Bun.which(name, { PATH: dir });
    if (found) return found;
  }
  return null;
}

let cached: Promise<FfmpegCapabilities> | null = null;

async function detect(): Promise<FfmpegCapabilities> {
  const ffmpeg = findFfmpegBinary("ffmpeg");
  const ffprobe = findFfmpegBinary("ffprobe");
  if (!ffmpeg) return { ffmpeg: null, ffprobe, encoder: null };
  for (const candidate of encoderCandidates()) {
    if (await encoderWorks(ffmpeg, candidate)) return { ffmpeg, ffprobe, encoder: candidate };
  }
  return { ffmpeg, ffprobe, encoder: null };
}

/** Cached capability lookup; the first call that finds ffmpeg pays for the encoder probes.
 *  "Not installed" is never cached — the user may be running `brew install ffmpeg` right now. */
export function getFfmpegCapabilities(): Promise<FfmpegCapabilities> {
  if (!cached) {
    cached = detect().then((caps) => {
      if (!caps.ffmpeg) cached = null;
      return caps;
    }).catch((e) => {
      cached = null; // let a later call retry after an unexpected failure
      throw e;
    });
  }
  return cached;
}

let cachedWorking: Promise<string[]> | null = null;

/**
 * **Every** candidate encoder that actually encodes on this host, in preference order — not
 * just the first one, which is what `getFfmpegCapabilities().encoder` stops at.
 *
 * Separate call, and separately cached, on purpose: `detect()` short-circuits because playing a
 * video inside the IDE has no use for the also-works list, and probing the rest costs one real
 * encode each (plus a 10s timeout apiece against a hung driver). Only the remote-desktop codec
 * picker wants the full list, so only it pays.
 */
export function workingEncoders(): Promise<string[]> {
  if (!cachedWorking) {
    cachedWorking = (async () => {
      const { ffmpeg } = await getFfmpegCapabilities();
      if (!ffmpeg) return [];
      const found: string[] = [];
      for (const candidate of encoderCandidates()) {
        if (await encoderWorks(ffmpeg, candidate)) found.push(candidate);
      }
      return found;
    })().then((list) => {
      // An empty list means either no ffmpeg or no working encoder; both are conditions the
      // user can fix from the checklist, so neither is remembered.
      if (list.length === 0) cachedWorking = null;
      return list;
    }).catch((e) => {
      cachedWorking = null;
      throw e;
    });
  }
  return cachedWorking;
}

/** Test hook: drop the cache so a different PATH can be probed. */
export function resetFfmpegCapabilitiesCache(): void {
  cached = null;
  cachedWorking = null;
}
