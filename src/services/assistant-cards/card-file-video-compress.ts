import { readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { findFfmpegBinary } from "../media-transcode/ffmpeg-capabilities.ts";
import { TELEGRAM_UPLOAD_MAX_BYTES, TELEGRAM_VIDEO_TARGET_BYTES } from "../../shared/card-files.ts";
import { createLogger } from "../logger.ts";

/**
 * A compressed copy of a card's video for Telegram, whose bots may upload 50 MB at most (an 83 MB
 * clip, say). The point is the best picture that fits, so:
 *
 *  - the resolution and frame rate are kept (a 1080×1920 clip stays 1080×1920);
 *  - the bitrate is the target size spread over the clip's length, and the encode is two-pass
 *    H.264 so the file lands close to that size with the bits spent where the picture needs them;
 *  - the audio is AAC at 128 kbps.
 *
 * A clip so long that its picture would get under {@link MIN_VIDEO_KBPS} is not compressed: the
 * user is told to open it in PPM, where the original is. If the copy still overshoots, one more
 * try asks for 90% of the target. One compression runs at a time on {@link THREADS} threads, so
 * a long clip never takes the whole machine.
 */

const log = createLogger("card-files");
const AUDIO_KBPS = 128;
/** Below this the picture is not worth sending: the user gets the PPM link instead. */
export const MIN_VIDEO_KBPS = 400;
export const MAX_VIDEO_KBPS = 40_000;
const THREADS = 4;
const PROBE_TIMEOUT_MS = 30_000;

export type CompressResult = { ok: true; size: number } | { ok: false; why: string };

/** `Duration: 00:01:23.45` from ffmpeg's banner, in seconds; null when absent or `N/A`. */
export function parseDurationSeconds(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) && s > 0 ? s : null;
}

/** Whether ffmpeg's banner shows an audio stream in the input. */
export function hasAudioStream(stderr: string): boolean {
  return /Stream #\d+:\d+[^\n]*: Audio:/.test(stderr);
}

/**
 * The bitrates for a clip of `seconds` to come out near `targetBytes`, or null when the picture
 * would be too poor. `scale` is the fraction of the target asked for (a retry after an overshoot
 * asks for less).
 */
export function compressPlan(seconds: number, opts: { targetBytes?: number; scale?: number; audio?: boolean } = {}):
  { videoKbps: number; audioKbps: number } | null {
  const target = (opts.targetBytes ?? TELEGRAM_VIDEO_TARGET_BYTES) * (opts.scale ?? 1);
  // 2% for the container; the rest is shared by the audio and the picture.
  const totalKbps = Math.floor((target * 8 * 0.98) / seconds / 1000);
  const audioKbps = opts.audio === false ? 0 : AUDIO_KBPS;
  // A cap no real 1080p delivery needs to pass: only a very short clip would ask for more.
  const videoKbps = Math.min(MAX_VIDEO_KBPS, totalKbps - audioKbps);
  return videoKbps >= MIN_VIDEO_KBPS ? { videoKbps, audioKbps } : null;
}

/**
 * ffmpeg's two runs: the first only measures the picture (no audio, nothing written), the second
 * writes the MP4. Both at the same bitrate and preset, sharing `passlog`.
 */
export function twoPassArgs(ffmpeg: string, input: string, output: string, passlog: string, plan: NonNullable<ReturnType<typeof compressPlan>>): [string[], string[]] {
  const video = [
    "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-b:v", `${plan.videoKbps}k`, "-maxrate", `${Math.round(plan.videoKbps * 1.5)}k`, "-bufsize", `${plan.videoKbps * 2}k`,
    "-passlogfile", passlog, "-threads", String(THREADS),
  ];
  const head = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input];
  const first = [...head, ...video, "-pass", "1", "-an", "-f", "null", "-"];
  const audio = plan.audioKbps > 0 ? ["-c:a", "aac", "-b:a", `${plan.audioKbps}k`] : ["-an"];
  const second = [...head, ...video, "-pass", "2", ...audio, "-movflags", "+faststart", output];
  return [first, second];
}

// Named so `ReturnType` keeps the narrowed pipe type; `typeof Bun.spawn` widens stderr to a union.
const spawnFfmpeg = (cmd: string[]) => Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  let proc: ReturnType<typeof spawnFfmpeg>;
  try {
    proc = spawnFfmpeg(cmd);
  } catch (e) {
    // Bun.spawn throws, rather than failing the run, when the binary vanished since the lookup.
    return { code: null, stderr: (e as Error).message };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stderr };
}

const lastLine = (stderr: string, code: number | null) => (stderr.trim().split("\n").slice(-1)[0] || `exit ${code ?? "killed"}`).slice(0, 200);

let chain: Promise<unknown> = Promise.resolve();

/** Whether ffmpeg is on this host: a video over the limit can then be compressed. */
export function canCompressVideo(): boolean {
  return findFfmpegBinary("ffmpeg") !== null;
}

/**
 * Writes a copy of `input` at `output` under Telegram's upload limit. Never throws: a failure is
 * the reason, in words the card can show.
 */
export function compressVideoForTelegram(input: string, output: string): Promise<CompressResult> {
  const next = chain.then(() => compressOnce(input, output), () => compressOnce(input, output));
  chain = next.catch(() => {});
  return next;
}

/** Removes the pass logs x264 leaves (`<passlog>-0.log`, `-0.log.mbtree`, …). */
async function removePassLogs(passlog: string): Promise<void> {
  const names = await readdir(dirname(passlog)).catch(() => [] as string[]);
  for (const name of names) if (name.startsWith(basename(passlog))) await rm(join(dirname(passlog), name), { force: true }).catch(() => {});
}

async function compressOnce(input: string, output: string): Promise<CompressResult> {
  const ffmpeg = findFfmpegBinary("ffmpeg");
  if (!ffmpeg) return { ok: false, why: "ffmpeg is not installed on the PPM host" };
  const probe = await run([ffmpeg, "-hide_banner", "-nostdin", "-i", input], PROBE_TIMEOUT_MS);
  const seconds = parseDurationSeconds(probe.stderr);
  if (!seconds) return { ok: false, why: "ffmpeg could not read the video's length" };
  const audio = hasAudioStream(probe.stderr);
  const part = `${output}.part.mp4`;
  const passlog = `${output}.passlog`;
  try {
    for (const scale of [1, 0.9]) {
      const plan = compressPlan(seconds, { scale, audio });
      if (!plan) return { ok: false, why: "the video is too long to fit in 50 MB at a watchable quality" };
      // Each pass up to four times the clip's length, at least ten minutes, at most an hour.
      const timeout = Math.min(60 * 60_000, Math.max(10 * 60_000, seconds * 4000));
      const started = Date.now();
      const [first, second] = twoPassArgs(ffmpeg, input, part, passlog, plan);
      for (const cmd of [first, second]) {
        const res = await run(cmd, timeout);
        if (res.code !== 0) return { ok: false, why: `ffmpeg could not compress it (${lastLine(res.stderr, res.code)})` };
      }
      const size = (await stat(part)).size;
      log.info(`card video compressed in ${Math.round((Date.now() - started) / 1000)}s to ${(size / 1024 / 1024).toFixed(1)} MB (two-pass, ${plan.videoKbps} kbps)`);
      if (size > 0 && size <= TELEGRAM_UPLOAD_MAX_BYTES) {
        await rename(part, output);
        return { ok: true, size };
      }
    }
    return { ok: false, why: "the compressed copy was still over 50 MB" };
  } catch (e) {
    return { ok: false, why: `compression failed (${(e as Error).message})` };
  } finally {
    await rm(part, { force: true }).catch(() => {});
    await removePassLogs(passlog);
  }
}
