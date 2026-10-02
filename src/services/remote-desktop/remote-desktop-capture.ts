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
import { encoderDeviceArgs, getFfmpegCapabilities } from "../media-transcode/ffmpeg-capabilities.ts";
import { captureEncoderArgs } from "./remote-desktop-encoder-args.ts";
import {
  captureInputArgs, captureVideoFilter, captureInputForPlatform,
  type CaptureInput, type CaptureRect,
} from "./remote-desktop-capture-input.ts";
import { detectLinuxSession, linuxSessionEnv } from "./remote-desktop-linux-session.ts";
import { DEFAULT_FPS, type QualityPreset } from "./remote-desktop-quality.ts";
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
  preset: QualityPreset = { fps: DEFAULT_FPS, bitrate: "1M" },
  drawMouse = true,
  publishUrl: string | null = null,
): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    "-fflags", "nobuffer", "-flags", "low_delay",
    // VAAPI opens its DRM device during input setup, so this has to precede `-i`.
    ...encoderDeviceArgs(encoder),
    ...captureInputArgs(input, preset, drawMouse),
    // Spread rather than a fixed pair: with no scale step a software encoder on x11grab/gdigrab
    // has nothing left to filter, and ffmpeg rejects `-vf ""` outright rather than ignoring it.
    ...withVideoFilter(captureVideoFilter(input, encoder, preset)),
    ...captureEncoderArgs(encoder, preset),
    "-flush_packets", "1",
    ...captureOutputArgs(publishUrl),
  ];
}

/**
 * Where the encoded H.264 goes: PPM's own WebSocket path reads it from `pipe:1`, the WebRTC
 * path pushes it into the local MediaMTX relay instead.
 *
 * Everything before this point is byte-identical between the two, which is the whole design:
 * the relay repackages what ffmpeg already encoded and never re-encodes, so the quality ladder,
 * the cursor flag, privacy mode and every per-platform grabber keep working unchanged.
 *
 * TCP, not the default UDP: the relay is on loopback where there is nothing to gain from UDP,
 * and a UDP push silently drops packets at MTU boundaries under load where TCP simply blocks.
 */
function captureOutputArgs(publishUrl: string | null): string[] {
  return publishUrl
    ? ["-f", "rtsp", "-rtsp_transport", "tcp", publishUrl]
    : ["-f", "h264", "pipe:1"];
}

function withVideoFilter(filter: string): string[] {
  return filter ? ["-vf", filter] : [];
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
  /** Resolution/frame-rate/bitrate rung; defaults to the balanced preset. */
  preset?: QualityPreset;
  /** Draw the host pointer into the frames. Defaults to true, and can only be changed by
   *  respawning: every grabber takes it as a startup flag. */
  drawMouse?: boolean;
  /** H.264 encoder to use, overriding the capability probe's first choice. Must be one that
   *  `workingEncoders()` reported: an encoder this build/GPU cannot run makes ffmpeg exit at
   *  once, which the session then reports as "Capture failed". */
  encoder?: string;
  /**
   * Push the encoded stream into this RTSP URL (the local MediaMTX relay) instead of reading
   * it back over `pipe:1`. When set there is no stdout to parse, so `onAccessUnit` is never
   * called and `cachedSps()` answers null — the browser learns the codec from the SDP the
   * relay answers with, not from PPM's own SPS parse.
   */
  publishUrl?: string | null;
  /** Required for the WebSocket path; ignored when `publishUrl` is set. */
  onAccessUnit?: (au: AccessUnit) => void;
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
  // Linux only: the grabber is chosen by session type, and ffmpeg is handed the session's
  // DISPLAY/XAUTHORITY because the PPM process very often has neither of its own.
  const session = process.platform === "linux" ? detectLinuxSession() : null;

  // Wayland has no ffmpeg grabber at all: the compositor only shares the screen through the
  // desktop portal, and ffmpeg can read the PipeWire node it hands back only when built
  // `--enable-libpipewire`, which distributions do not do. That backend is GStreamer-based and
  // lives in its own module; it produces the same Annex-B stdout, so nothing downstream differs.
  // The import is dynamic to keep the two files out of a require cycle — the Wayland module
  // needs `CaptureUnavailableError` and the option types from here.
  if (session?.kind === "wayland") {
    const { startWaylandCapture } = await import("./remote-desktop-capture-wayland.ts");
    return startWaylandCapture({ ...opts, session, ffmpeg: caps.ffmpeg ?? null });
  }

  const d = opts.display;
  const rect: CaptureRect | null =
    d && d.width > 0 && d.height > 0 ? { x: d.x, y: d.y, width: d.width, height: d.height } : null;
  const input = captureInputForPlatform(process.platform, d?.captureIndex ?? 0, { session, rect });
  if (!input) throw new CaptureUnavailableError(`no screen capture input on ${process.platform}`);

  const publishUrl = opts.publishUrl ?? null;
  if (!publishUrl && !opts.onAccessUnit) {
    throw new CaptureUnavailableError("startCapture needs either onAccessUnit or publishUrl");
  }
  const argv = buildCaptureArgs(
    caps.ffmpeg, opts.encoder ?? caps.encoder ?? "libx264", input, opts.preset,
    opts.drawMouse ?? true, publishUrl,
  );
  const proc = Bun.spawn(argv, {
    // Always a pipe, in both modes. Making it conditional widens Bun's spawn type so that
    // `proc.stdout` is possibly-undefined everywhere below, and the RTSP mode writes nothing
    // to stdout anyway (ffmpeg logs to stderr) — it is drained rather than left unread so a
    // future log line on stdout cannot block the encoder.
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(session ? { env: { ...process.env, ...linuxSessionEnv(session) } } : {}),
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

  // The relay reads the stream over RTSP, so there is nothing to assemble here — just drain
  // stdout with the same manual pull loop (never a cancel; see the file header).
  if (publishUrl) {
    const idle = proc.stdout.getReader();
    (async () => { for (;;) { const { done } = await idle.read(); if (done) return; } })()
      .catch(() => { /* the process is gone; stop() has already run or is about to */ });
    return { cachedSps: () => null, stop, isStopped: () => stopped };
  }

  const assembler = new AccessUnitAssembler();
  const onAccessUnit = opts.onAccessUnit!;

  // Manual pull loop — the only safe way to drain this stdout (see file header). Runs
  // detached from the caller; it terminates itself once `proc.kill()` resolves the pending
  // read with `done: true`, never via an external cancel.
  const reader = proc.stdout.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      for (const au of assembler.push(value)) onAccessUnit(au);
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
