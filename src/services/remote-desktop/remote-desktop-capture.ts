/**
 * Spawn ffmpeg (`gdigrab` → H.264 Annex-B on `pipe:1`) and turn its stdout into access units.
 *
 * Teardown is `proc.kill()` only — never `reader.cancel()`, never `for await (chunk of
 * proc.stdout) { ... break }`. Both of those cancel the underlying stream reader, which
 * segfaults Bun 1.3.x on Windows the instant a consumer goes away (see
 * `transcode-stream.ts:130-148` and `tests/integration/transcode-stream-client-disconnect.test.ts`
 * — that guard targets a `Response` body; the WS rewrite here re-creates the same trap one
 * layer down if the pump loop is written as `for await`). `stop()` only calls `proc.kill()`;
 * the in-flight `reader.read()` then resolves with `done: true` and the pump loop exits on
 * its own — it is never cancelled from outside.
 */
import { getFfmpegCapabilities } from "../media-transcode/ffmpeg-capabilities.ts";
import { captureEncoderArgs, CAPTURE_FRAMERATE } from "./remote-desktop-encoder-args.ts";
import { AccessUnitAssembler, type AccessUnit } from "./access-unit-assembler.ts";

export class CaptureUnavailableError extends Error {
  constructor(msg = "ffmpeg is not installed (gdigrab capture requires it)") {
    super(msg);
    this.name = "CaptureUnavailableError";
  }
}

/** Build the gdigrab argv; pure so it can be asserted on without spawning a process. */
export function buildCaptureArgs(ffmpeg: string): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "gdigrab", "-framerate", String(CAPTURE_FRAMERATE), "-i", "desktop",
    "-vf", "scale=-2:720",
    ...captureEncoderArgs(),
    "-f", "h264", "pipe:1",
  ];
}

export interface CaptureHandle {
  /** SPS bytes cached from the stream (for the avc1 codec string), null before the encoder's
   *  first keyframe has been parsed. */
  cachedSps(): Uint8Array | null;
  /** Kill ffmpeg. Idempotent, safe to call from multiple teardown paths. */
  stop(): void;
  /** True once `stop()` has run or the process exited on its own. */
  isStopped(): boolean;
}

export interface StartCaptureOptions {
  onAccessUnit: (au: AccessUnit) => void;
  /** Called once the process exits, whether via `stop()` or on its own (crash/killed
   *  externally) — lets the session registry clean up without polling. `reason` is a short
   *  stderr tail, present only when ffmpeg died on its own (e.g. gdigrab access denied on a
   *  disconnected session) so the caller can surface *why* to the client instead of a bare
   *  disconnect. */
  onExit?: (code: number | null, reason?: string) => void;
}

/** Start gdigrab capture. Rejects immediately if ffmpeg is not on PATH. */
export async function startCapture(opts: StartCaptureOptions): Promise<CaptureHandle> {
  const caps = await getFfmpegCapabilities();
  if (!caps.ffmpeg) throw new CaptureUnavailableError();

  const proc = Bun.spawn(buildCaptureArgs(caps.ffmpeg), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!proc.killed) proc.kill();
  };

  // Drain stderr so ffmpeg never blocks on a full pipe; keep a short tail for diagnostics.
  const stderrTail = new Response(proc.stderr).text().catch(() => "");
  proc.exited.then(async (code) => {
    // Read `stopped` BEFORE overwriting it: this is the only reliable "did WE ask ffmpeg to
    // die" signal. `proc.killed` is NOT reliable for that — Bun sets it `true` even when
    // ffmpeg exits on its own with a nonzero code (verified: gdigrab "access denied" on a
    // disconnected session exits with `killed: true` despite `stop()` never having been
    // called), which previously suppressed this warning — and any client-facing error —
    // for exactly the crash this exists to report.
    const diedOnItsOwn = !stopped;
    stopped = true;
    let reason: string | undefined;
    if (diedOnItsOwn && code !== 0 && code !== null) {
      reason = (await stderrTail).trim().split("\n").slice(-3).join(" | ");
      console.warn(`[remote-desktop] ffmpeg exited ${code}: ${reason}`);
    }
    opts.onExit?.(code, reason);
  });

  const assembler = new AccessUnitAssembler();

  // Manual pull loop — the only safe way to drain this stdout (see file header). Runs
  // detached from the caller; it terminates itself once `proc.kill()` resolves the pending
  // read with `done: true`, never via an external cancel.
  const reader = proc.stdout.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      for (const au of assembler.push(value)) opts.onAccessUnit(au);
    }
  })().catch((e) => {
    console.error(`[remote-desktop] capture pump failed: ${(e as Error).message}`);
  });

  return {
    cachedSps: () => assembler.cachedSps(),
    stop,
    isStopped: () => stopped,
  };
}
