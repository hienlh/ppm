/**
 * Spawn ffmpeg (platform grabber → H.264 Annex-B on `pipe:1`) and turn its stdout into access units.
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
import { captureEncoderArgs } from "./remote-desktop-encoder-args.ts";
import {
  captureInputArgs, captureVideoFilter, captureInputForPlatform, type CaptureInput,
} from "./remote-desktop-capture-input.ts";
import { AccessUnitAssembler, type AccessUnit } from "./access-unit-assembler.ts";
import type { RemoteDisplay } from "./remote-desktop-displays.ts";

export class CaptureUnavailableError extends Error {
  constructor(msg = "ffmpeg is not installed (screen capture requires it)") {
    super(msg);
    this.name = "CaptureUnavailableError";
  }
}

/** Build the capture argv; pure so it can be asserted on without spawning a process.
 *  `-fflags nobuffer -flags low_delay` + `-flush_packets 1` stop ffmpeg from holding frames in
 *  its demux/mux buffers before emitting — on a fast/LAN transport that buffering is a big slice
 *  of the felt lag. `encoder` selects the H.264 encoder args (hardware NVENC/QSV/AMF/VideoToolbox
 *  when the capability probe found one, else libx264); `input` selects the platform grabber. */
export function buildCaptureArgs(
  ffmpeg: string,
  encoder: string = "libx264",
  input: CaptureInput = { kind: "gdigrab" },
): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    "-fflags", "nobuffer", "-flags", "low_delay",
    ...captureInputArgs(input),
    "-vf", captureVideoFilter(input),
    ...captureEncoderArgs(encoder),
    "-flush_packets", "1",
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
  /** Which display to grab; null/undefined = the platform default (primary / whole desktop). */
  display?: RemoteDisplay | null;
  onAccessUnit: (au: AccessUnit) => void;
  /** Called once the process exits, whether via `stop()` or on its own (crash/killed
   *  externally) — lets the session registry clean up without polling. `reason` is a short
   *  stderr tail, present only when ffmpeg died on its own (e.g. gdigrab access denied on a
   *  disconnected session) so the caller can surface *why* to the client instead of a bare
   *  disconnect. */
  onExit?: (code: number | null, reason?: string) => void;
}

/** Start screen capture. Rejects immediately if ffmpeg is not on PATH or the platform has
 *  no supported grabber. */
export async function startCapture(opts: StartCaptureOptions): Promise<CaptureHandle> {
  const caps = await getFfmpegCapabilities();
  if (!caps.ffmpeg) throw new CaptureUnavailableError();
  const input = captureInputForPlatform(process.platform, opts.display?.captureIndex ?? 0);
  if (!input) throw new CaptureUnavailableError(`no screen capture input on ${process.platform}`);

  const proc = Bun.spawn(buildCaptureArgs(caps.ffmpeg, caps.encoder ?? "libx264", input), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // SIGKILL, not the default SIGTERM: ffmpeg's avfoundation input hangs on SIGTERM/SIGINT
    // during capture-session teardown (verified on macOS 26 — the process stayed alive for
    // minutes after both) and would leak one screen-capture ffmpeg per remote-desktop session.
    // On Windows Bun's kill is TerminateProcess either way, so the semantics are unchanged.
    if (!proc.killed) proc.kill("SIGKILL");
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
