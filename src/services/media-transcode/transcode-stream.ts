/**
 * Spawn ffmpeg to re-encode a file the browser cannot play (AVI/MJPEG, MKV/AC3, HEVC…)
 * into a fragmented MP4 that streams to `<video>` while it is still being produced.
 *
 * Why fragmented MP4 rather than HLS: a single progressive pipe needs no segmenter,
 * no playlist, no temp files, and starts within a second. The trade-off is that the
 * stream has no duration and cannot be seeked natively — the client handles seeking
 * by re-requesting with `start`, which becomes `-ss` *before* `-i` (fast keyframe
 * seek; exact-frame seeking would decode from the file start every time).
 *
 * Every spawned process is tied to the response body: when the browser drops the
 * connection (tab closed, seek, next file) the stream is cancelled and only that PID
 * is killed — never a blanket kill by image name.
 */
import { encoderArgs, getFfmpegCapabilities } from "./ffmpeg-capabilities.ts";

/** Parallel ffmpeg jobs allowed. A seek briefly overlaps old + new job, so allow a little slack. */
export const MAX_CONCURRENT_TRANSCODES = 3;
let active = 0;

/** How many transcodes are running right now (exposed for tests/diagnostics). */
export function activeTranscodeCount(): number {
  return active;
}

export class TranscodeUnavailableError extends Error {
  constructor(msg = "ffmpeg is not installed or has no working H.264 encoder") {
    super(msg);
    this.name = "TranscodeUnavailableError";
  }
}

export class TranscodeBusyError extends Error {
  constructor() {
    super(`Too many concurrent transcodes (max ${MAX_CONCURRENT_TRANSCODES})`);
    this.name = "TranscodeBusyError";
  }
}

export interface TranscodeOptions {
  /** Seconds to skip before encoding. */
  start?: number;
  /** Aborts the job when the HTTP request is aborted. */
  signal?: AbortSignal;
}

/** Build the ffmpeg argv; pure so tests can assert on it without spawning. */
export function buildTranscodeArgs(ffmpeg: string, absPath: string, encoder: string, start = 0): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
    "-i", absPath,
    // First video + first audio track; `?` makes the audio map optional (silent clips).
    "-map", "0:v:0", "-map", "0:a:0?",
    // Browsers only decode 4:2:0 H.264; cap at 1080p keeping even dimensions.
    "-vf", "scale='min(1920,iw)':-2", "-pix_fmt", "yuv420p",
    ...encoderArgs(encoder),
    // 2s keyframe interval at 30fps → fragments start quickly after a seek.
    "-g", "60",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
}

export interface TranscodeJob {
  stream: ReadableStream<Uint8Array>;
  encoder: string;
}

/** Start a transcode; the returned stream is the fMP4 body to hand to `Response`. */
export async function startTranscode(absPath: string, opts: TranscodeOptions = {}): Promise<TranscodeJob> {
  const caps = await getFfmpegCapabilities();
  if (!caps.ffmpeg || !caps.encoder) throw new TranscodeUnavailableError();
  if (active >= MAX_CONCURRENT_TRANSCODES) throw new TranscodeBusyError();

  const proc = Bun.spawn(buildTranscodeArgs(caps.ffmpeg, absPath, caps.encoder, opts.start), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  active++;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    active--;
  };

  // Drain stderr so ffmpeg never blocks on a full pipe; keep the tail for the log.
  const stderrTail = new Response(proc.stderr).text().catch(() => "");
  proc.exited.then(async (code) => {
    finish();
    if (code !== 0 && code !== null && !proc.killed) {
      const tail = (await stderrTail).trim().split("\n").slice(-3).join(" | ");
      console.warn(`[transcode] ffmpeg exited ${code} for ${absPath}: ${tail}`);
    }
  });

  const kill = () => {
    if (!proc.killed) proc.kill();
    finish();
  };
  opts.signal?.addEventListener("abort", kill, { once: true });

  // Wrap stdout so a cancelled response body (client went away) kills this process.
  //
  // The wrapper is not optional: handing `proc.stdout` straight to `Response`, or calling
  // `reader.cancel()` on it, segfaults Bun 1.3.x on Windows the moment the client
  // disconnects (guarded by tests/integration/transcode-stream-client-disconnect.test.ts).
  // Killing the process is enough — its stdout then ends and the pending read resolves `done`.
  const reader = proc.stdout.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        try { controller.close(); } catch { /* already cancelled */ }
        finish();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      kill();
    },
  });

  return { stream, encoder: caps.encoder };
}
