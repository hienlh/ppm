/**
 * gRPC RGB888 frames -> ffmpeg -> H.264 access units.
 *
 * This is ADR-B option 1, chosen on Phase 0 measurements: grpc-js under Bun sustained 40 fps and
 * 297 MiB/s at full resolution with zero dropped frames, so the transport is not the bottleneck
 * the plan feared. Six things here come from that work or from the proto, and each one is a
 * silent bug if removed:
 *
 *  1. **No `vflip`, despite what the proto says.** `emulator_controller.proto` states the pixel
 *     buffer runs "left to right and bottom up", and both the plan and the Phase 0 report took
 *     that at its word. It is wrong on emulator 36.5.10: matched row by row against
 *     `adb exec-out screencap`, which is unambiguously top-down, the gRPC buffer agrees at a mean
 *     difference of **1.21** per pixel and disagrees at **37.15** when flipped. A `vflip` here
 *     would render every screen upside down, with no error from anything.
 *  2. **The requested size is a bounding box, and the emulator decides the real one.** The proto
 *     is explicit: "The returned image will never exceed the given width, but can be less",
 *     scaled "while maintaining the aspect ratio of the device". Phase 0 asked 720x1600 and got
 *     exactly that only because it matched the device's aspect. Every frame carries the real
 *     `format.width/height/rotation` as **output** fields, so those are read rather than assumed
 *     — which is also what makes rotation work without guessing what it does to the geometry.
 *  3. **The box is square, and it is opened exactly once.** A portrait box would collapse a
 *     landscape guest into a sliver (1600x720 inside a 720x1600 box is 720x324), so the ceiling
 *     is applied to the *long* edge by asking for `maxHeight x maxHeight` — rotation-invariant,
 *     so the picture keeps its resolution when the guest turns. It is opened at the **highest**
 *     rung's ceiling and never reopened, because a cancelled `streamScreenshot` cannot be
 *     replaced: measured on emulator 36.5.10, every stream opened after one has been cancelled
 *     delivers exactly **one** frame and then nothing, on a fresh channel as well as the same
 *     one. So a rung change is an ffmpeg `scale` and a respawned encoder, never a new stream.
 *  4. **Pacing uses an accumulating deadline.** "Has one interval passed since the last frame I
 *     took" turns a 40 fps source into 20 fps at a 30 fps target — measured 242 frames over 12 s
 *     instead of 360. `nextDue = max(now, nextDue + interval)` is what gives the right count.
 *  5. **A frame once started is written whole.** rawvideo carries no frame header, so a short
 *     write desynchronises the decoder permanently. Only a frame not yet begun may be dropped.
 *  6. **`flush()` is what actually writes.** Bun's stdin is a FileSink whose `write()` only
 *     buffers and returns the byte count immediately, so a write loop alone proves nothing
 *     reached ffmpeg.
 */
import { AccessUnitAssembler, type AccessUnit } from "../remote-desktop/access-unit-assembler.ts";
import { avc1CodecString } from "../remote-desktop/avc1-codec-string.ts";
import { getFfmpegCapabilities, workingEncoders } from "../media-transcode/ffmpeg-capabilities.ts";
import { connectToEmulator, type EmulatorChannel } from "./android-grpc.ts";
import type { RunningEmulator } from "./emulator-discovery.ts";
import { ANDROID_QUALITY_PRESETS, type AndroidQuality } from "../../shared/android-protocol.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("android");

// The H.264 helpers above live under remote-desktop/ and are imported rather than moved: they
// are pure, dependency-free bitstream utilities, and relocating them would touch nine files
// across a working, well-tested feature for no behavioural gain (plan §8 says extract them only
// "if needed"). If a third consumer ever appears, that is the moment to give them a neutral home.

/** The picture the client actually receives: the encoded size, which may be a scaled copy of
 *  what the emulator sends, plus the guest's own orientation. */
export interface FrameGeometry {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

/** The one box ever requested from the emulator: the highest rung's ceiling, so every rung is
 *  reachable by scaling down and the stream never has to be reopened. */
export const STREAM_BOX = Math.max(...Object.values(ANDROID_QUALITY_PRESETS).map((p) => p.maxHeight));

/**
 * How long after the last real change the pipeline keeps sending at the rung's full rate, and
 * what it falls back to once the guest screen has gone still.
 *
 * Repeating a motionless picture is not free: measured on this host with the screen untouched,
 * one viewer held ffmpeg at **55% of one core** — the rgb24 frame is rescaled and uploaded every
 * time, whether or not a pixel moved. It cannot simply stop, though; see `lastFrame`. Ten frames
 * a second is the compromise, measured on the same screen: **11.7 frames/s into ffmpeg for 23%
 * of a core**, while the client still receives 24.9 access units a second, because the rawvideo
 * demuxer declares 25 fps and ffmpeg's default CFR sync pads the output back up to it — and a
 * duplicate costs the encoder almost nothing, since the expensive half happens per *input*
 * frame. A viewer joining a still device therefore still has a keyframe inside a second.
 */
const IDLE_AFTER_MS = 1000;
const IDLE_FPS = 10;

/** Even dimensions only: H.264 chroma is subsampled and an odd size is rejected outright. */
function evenDown(n: number): number {
  return Math.max(2, n % 2 === 0 ? n : n - 1);
}

/**
 * Fit a frame under a rung's ceiling, applied to the **long** edge so a rotation does not change
 * how much detail a rung buys. Never upscales: a rung above the source is the source.
 */
export function fitLongEdge(width: number, height: number, ceiling: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= ceiling) return { width: evenDown(width), height: evenDown(height) };
  const scale = ceiling / longEdge;
  return { width: evenDown(Math.round(width * scale)), height: evenDown(Math.round(height * scale)) };
}

export interface VideoPipelineOptions {
  emulator: RunningEmulator;
  quality: AndroidQuality;
  onAccessUnit: (au: AccessUnit, ptsMs: number) => void;
  /** Called once at startup and again whenever the emulator changes the frame size or rotation. */
  onGeometry: (geometry: FrameGeometry) => void;
  onError: (message: string) => void;
}

export interface RunningPipeline {
  readonly geometry: FrameGeometry;
  /** ffmpeg's encoder name, for display. Not what the browser's decoder is configured with. */
  readonly encoder: string;
  /** The current bitstream's WebCodecs codec string, null until its first keyframe. */
  codecString(): string | null;
  readonly fps: number;
  stop(): Promise<void>;
  /** Frames stop being requested while hidden; the emulator and the session stay up. */
  setPaused(paused: boolean): void;
  /** Switch rung. Respawns the encoder; the emulator's stream is never touched. */
  setQuality(quality: AndroidQuality): Promise<void>;
  /** Frames the emulator sent, and frames that survived pacing and reached ffmpeg. The gap
   *  between the two IS the pacing, so a stall shows up as which of them stopped moving. */
  stats(): { sourceFrames: number; fedFrames: number };
}

/** The proto's `SkinRotation` in the terms the viewer uses. */
const ROTATION_DEGREES: Record<string, 0 | 90 | 180 | 270> = {
  PORTRAIT: 0, LANDSCAPE: 90, REVERSE_PORTRAIT: 180, REVERSE_LANDSCAPE: 270,
};

function rotationOf(format: any): 0 | 90 | 180 | 270 {
  const r = format?.rotation?.rotation;
  if (typeof r === "string" && r in ROTATION_DEGREES) return ROTATION_DEGREES[r]!;
  return 0;
}

/**
 * ffmpeg arguments per encoder. VAAPI is not a drop-in `-c:v` swap: `-vaapi_device` must precede
 * `-i` because it opens during input setup, the upload must be in the SAME `-vf` chain (a second
 * `-vf` replaces the first), and `-pix_fmt yuv420p` has to go or the hardware frame context is
 * rejected. Measured on an Intel UHD 770: VAAPI held 33% of a core against libx264's 64-80%.
 */
export function encoderArgs(opts: {
  encoder: string; width: number; height: number; fps: number; bitrate: string;
  /** Encoded size, when it differs from the source. Omit for no scaling. */
  outWidth?: number; outHeight?: number;
  vaapiDevice?: string;
}): string[] {
  const { encoder, width, height, fps, bitrate } = opts;
  const input = [
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`,
    // `-framerate` is **not** redundant beside the wallclock timestamps, and leaving it out costs
    // one frame in six. The rawvideo demuxer assumes **25 fps** when nothing says otherwise, and
    // ffmpeg's default CFR sync then conforms the output to that rate — measured, feeding a real
    // 30 fps produced 151 access units from 180 frames, dropped unevenly, which is exactly what
    // dragging on the device looked like. Nothing warns: the picture is correct, there is simply
    // less of it. With the rate declared, 180 frames in gave 180 access units out.
    "-framerate", String(fps),
    "-use_wallclock_as_timestamps", "1", "-i", "pipe:0",
  ];
  // An exact size rather than a filter expression: the pipeline always knows both, because a
  // geometry change and a rung change each respawn the encoder. `scale=w:h` with numbers cannot
  // be got subtly wrong the way `min(ih,H)` can when the frame is landscape.
  const scale = opts.outWidth && opts.outHeight && (opts.outWidth !== width || opts.outHeight !== height)
    ? `scale=${opts.outWidth}:${opts.outHeight},` : "";
  // Half-second GOP: it bounds every resync freeze and every late joiner's wait for a first
  // decodable frame, and on a rate-capped encode costs no measurable bitrate — the same finding
  // the Remote Desktop ladder is built on.
  const gop = ["-g", String(Math.max(1, Math.round(fps / 2)))];
  const out = ["-f", "h264", "pipe:1"];

  if (encoder === "h264_vaapi") {
    return [
      "-vaapi_device", opts.vaapiDevice ?? "/dev/dri/renderD128",
      ...input,
      "-vf", `${scale}format=nv12,hwupload`,
      "-c:v", "h264_vaapi", "-b:v", bitrate, ...gop, ...out,
    ];
  }
  if (encoder === "h264_qsv") {
    return [...input, "-vf", `${scale}format=nv12`,
      "-c:v", "h264_qsv", "-b:v", bitrate, "-low_power", "1", ...gop, ...out];
  }
  if (encoder === "h264_nvenc") {
    return [...input, "-vf", `${scale}format=yuv420p`,
      "-c:v", "h264_nvenc", "-b:v", bitrate, "-preset", "p1", "-tune", "ll", ...gop, ...out];
  }
  return [...input, "-vf", `${scale}format=yuv420p`,
    "-c:v", encoder, "-b:v", bitrate, "-preset", "veryfast", "-tune", "zerolatency", ...gop, ...out];
}

/** Hardware first, software last — but only among encoders that really encode on this host. */
export function pickEncoder(available: string[]): string {
  for (const preferred of ["h264_vaapi", "h264_qsv", "h264_nvenc", "h264_amf"]) {
    if (available.includes(preferred)) return preferred;
  }
  return available[0] ?? "libx264";
}

/** Named so `ReturnType<typeof spawnFfmpeg>` keeps the narrowed `stdin`/`stdout` types. Written
 *  inline the union comes back — `stdout` widens to `number | ReadableStream` and `.getReader()`
 *  stops type-checking, the same trap `host-info/spawn-runner.ts` records in CLAUDE.md. */
function spawnFfmpeg(ffmpeg: string, args: string[]) {
  return Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", ...args], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
}

/** One ffmpeg, locked to one frame size. A geometry change means a new one of these. */
/**
 * Hand one whole raw frame to the encoder's stdin.
 *
 * One `write()`, then `flush()` — **never** a partial-write loop over the return value.
 * `FileSink.write()` takes the whole chunk and answers a number that is *not* how much of this
 * chunk it consumed: measured against `cat` with one real 4,924,800-byte frame, it returned
 * 475072 eleven times while having already buffered everything, so a loop doing `off += n`
 * re-sent the tail ten more times and `cat` received **28,043,840 bytes — 5.7x the frame**.
 * ffmpeg's rawvideo input is then offset for good: the *first* picture decodes perfectly and
 * every one after it is drawn rolled, with no error from ffmpeg, from the sink, or from
 * anything else. It is its own function only so a test can measure the bytes that come out the
 * other end (`tests/unit/android/android-video-frame-write.test.ts`) — a frame counter cannot
 * see this bug.
 */
export async function writeFrameToSink(
  sink: { write: (c: Uint8Array) => unknown; flush: () => unknown },
  frame: Uint8Array,
): Promise<void> {
  sink.write(frame);
  await sink.flush();
}

class Encoder {
  private readonly proc: ReturnType<typeof spawnFfmpeg>;
  private readonly assembler = new AccessUnitAssembler();
  private readonly sink: { write(c: Uint8Array): number | Promise<number>; flush(): number | Promise<number> };
  private inFlight: Promise<void> = Promise.resolve();
  private pending: Buffer | null = null;
  private stopped = false;
  readonly outPump: Promise<void>;

  constructor(
    ffmpeg: string,
    args: string[],
    private readonly onAccessUnit: (au: AccessUnit) => void,
    private readonly onError: (m: string) => void,
  ) {
    this.proc = spawnFfmpeg(ffmpeg, args);
    this.sink = this.proc.stdin as never;

    // Manual pull loop, NOT `for await (...) { break }`. Breaking out of a for-await cancels the
    // underlying reader, which segfaults Bun 1.3.x on Windows the moment a consumer goes away —
    // the hazard `remote-desktop-capture.ts` documents at length and guards the same way.
    // Teardown is `kill()` only; the pending read then resolves `done: true` and this exits.
    const outReader = this.proc.stdout.getReader();
    this.outPump = (async () => {
      for (;;) {
        const { done, value } = await outReader.read();
        if (done) return;
        if (!value) continue;
        for (const au of this.assembler.push(value)) this.onAccessUnit(au);
      }
    })().catch((e) => {
      if (this.stopped) return;
      log.error(`encoder pid=${this.proc.pid} output failed: ${(e as Error).message}`);
      this.onError(`encoder output failed: ${(e as Error).message}`);
    });

    let lastStderr = "";
    const errReader = this.proc.stderr.getReader();
    const errPump = (async () => {
      for (;;) {
        const { done, value } = await errReader.read();
        if (done) return;
        if (!value) continue;
        const text = new TextDecoder().decode(value).trim();
        if (text) lastStderr = text.split("\n").slice(-1)[0] ?? lastStderr;
        if (text && !this.stopped) this.onError(`encoder: ${text.split("\n").slice(-1)[0]}`);
      }
    })().catch(() => { /* closed with the process */ });

    // Nothing else watches the process: a crashed ffmpeg left the pipeline feeding a dead encoder
    // with every write error swallowed, and its stderr shown only to whoever was watching.
    void this.proc.exited.then(async () => {
      if (this.stopped) { log.debug(`encoder pid=${this.proc.pid} stopped`); return; }
      await Promise.race([errPump, Bun.sleep(500)]);   // its last line is usually the reason
      log.error(
        `encoder pid=${this.proc.pid} exited unexpectedly code=${this.proc.exitCode} ` +
        `signal=${this.proc.signalCode}: ${lastStderr || "(no stderr)"}`,
      );
    });
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** The `avc1.PPCCLL` string this encoder's real bitstream implies, null before its first
   *  keyframe. Derived, never guessed: `encoderArgs` sets no profile or level. */
  codecString(): string | null {
    const sps = this.assembler.cachedSps();
    return sps ? avc1CodecString(sps) : null;
  }

  /** Queue a frame. Only a frame that has not started being written may be superseded. */
  feed(buf: Buffer): void {
    if (this.stopped) return;
    this.pending = buf;
    this.inFlight = this.inFlight.then(async () => {
      while (this.pending && !this.stopped) {
        const frame = this.pending;
        this.pending = null;
        try {
          await writeFrameToSink(this.sink, frame);
        } catch { /* the encoder is gone; stop() reports it */ }
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Kill FIRST, then wait. Waiting on the write chain before killing makes teardown hostage to
    // an ffmpeg that has stopped reading its stdin: `flush()` would never resolve and the process
    // would outlive PPM. Killing first can only turn a pending write into an EPIPE, which the
    // write loop already swallows.
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    try { this.proc.kill(); } catch { /* already exited */ }
    await Promise.race([this.inFlight.catch(() => {}), Bun.sleep(1000)]);
    await Promise.race([this.outPump, Bun.sleep(1000)]);
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
  }
}

export async function startVideoPipeline(opts: VideoPipelineOptions): Promise<RunningPipeline> {
  // The binary the capability check found, not a bare "ffmpeg": that check also looks outside
  // PATH (Homebrew's prefixes, WinGet's links), which a service-started PPM often lacks.
  const found = (await getFfmpegCapabilities()).ffmpeg;
  if (!found) throw new Error("ffmpeg is not installed on this host");
  const ffmpeg: string = found;
  const encoderName = pickEncoder(await workingEncoders());
  const channel: EmulatorChannel = connectToEmulator(opts.emulator);
  const startedAt = performance.now();

  let quality = opts.quality;
  let preset = ANDROID_QUALITY_PRESETS[quality];
  /** What the emulator is sending, before any scaling of ours. */
  let source: FrameGeometry | null = null;
  /** What the client receives. */
  let geometry: FrameGeometry | null = null;
  let encoder: Encoder | null = null;
  let stopped = false;
  let paused = false;
  let nextDue = 0;
  let sourceFrames = 0;
  let fedFrames = 0;
  /**
   * The newest frame the emulator has sent, kept so the pacer can send it again.
   *
   * `streamScreenshot` is **change-driven**: the emulator sends a frame when the screen changes
   * and then nothing at all — measured, a device sitting on its launcher produced *2 frames in
   * 15 seconds*. Feeding ffmpeg only on arrival therefore stops the H.264 stream completely on a
   * still screen, so a viewer that joins then waits on "Waiting for the first frame…" until
   * something moves in the guest, and one already watching cannot tell a frozen picture from a
   * dropped connection. The fix is to keep feeding the last frame: the GOP is half a second, so
   * a viewer joining a motionless device has a keyframe within 500 ms.
   */
  let lastFrame: Buffer | null = null;
  let lastChangeAt = 0;
  let pacer: ReturnType<typeof setInterval> | null = null;

  const emitAu = (au: AccessUnit) => opts.onAccessUnit(au, performance.now() - startedAt);

  /** Tear down the encoder and start one for the current source and rung. `reason` is for the
   *  log: the first frame, a new frame size (a rotation), or a quality change. */
  function respawnEncoder(src: FrameGeometry, reason: "start" | "geometry" | "quality"): FrameGeometry {
    const out = fitLongEdge(src.width, src.height, preset.maxHeight);
    const previous = encoder;
    encoder = null;
    try {
      encoder = new Encoder(
        ffmpeg,
        encoderArgs({
          encoder: encoderName,
          width: src.width, height: src.height,
          outWidth: out.width, outHeight: out.height,
          fps: preset.fps, bitrate: preset.bitrate,
        }),
        emitAu,
        (m) => { if (!stopped) opts.onError(m); },
      );
      log.info(
        `encoder started pid=${encoder.pid} avd=${opts.emulator.avdName} encoder=${encoderName} ` +
        `src=${src.width}x${src.height} out=${out.width}x${out.height} fps=${preset.fps} ` +
        `bitrate=${preset.bitrate} reason=${reason}`,
      );
    } catch (e) {
      // Bun.spawn throws synchronously on a binary it cannot run, and this runs inside the gRPC
      // stream's frame handler, where a throw would escape as an uncaught exception.
      if (!stopped) {
        log.error(`encoder spawn failed: ${(e as Error).message}`);
        opts.onError(`could not start ffmpeg: ${(e as Error).message}`);
      }
    }
    nextDue = 0;
    startPacer();                      // the rung may have changed the frame rate
    // Drained in the background: its remaining access units describe a picture the client has
    // already been told is gone.
    if (previous) void previous.stop();
    return { width: out.width, height: out.height, rotation: src.rotation };
  }

  /** Hand the newest frame to the encoder if the rung's cadence allows one now. */
  function feedNow(): void {
    if (stopped || paused || !lastFrame) return;
    const now = performance.now();
    if (nextDue === 0) nextDue = now;
    if (now < nextDue) return;
    const fps = now - lastChangeAt > IDLE_AFTER_MS ? Math.min(IDLE_FPS, preset.fps) : preset.fps;
    nextDue = Math.max(now, nextDue + 1000 / fps);
    fedFrames++;
    encoder?.feed(lastFrame);
  }

  /**
   * Ticks at *half* the frame interval on purpose. A tick landing just before the next frame is
   * due does nothing, so a tick exactly one period long would halve the rate whenever the two
   * fall out of phase; at half a period the cadence holds.
   */
  function startPacer(): void {
    if (pacer) clearInterval(pacer);
    pacer = setInterval(feedNow, Math.max(5, Math.round(500 / preset.fps)));
  }

  function stopPacer(): void {
    if (pacer) clearInterval(pacer);
    pacer = null;
  }

  function onFrame(img: any): void {
    if (stopped || paused) return;
    const buf: Buffer | undefined = img?.image;
    const width = Number(img?.format?.width ?? 0);
    const height = Number(img?.format?.height ?? 0);
    if (!buf || width <= 0 || height <= 0) return;
    // The declared size and the payload must agree before ffmpeg ever sees it: a short buffer
    // desynchronises the raw stream permanently, with no error from anything.
    if (buf.length !== width * height * 3) return;
    sourceFrames++;

    const rotation = rotationOf(img.format);
    if (!source || source.width !== width || source.height !== height || source.rotation !== rotation) {
      const reason = source ? "geometry" : "start";
      source = { width, height, rotation };
      geometry = respawnEncoder(source, reason);
      opts.onGeometry(geometry);
    }

    const now = performance.now();
    // Coming out of idle, the next slot was scheduled at the *idle* rate and may be up to 100 ms
    // away — that delay would land on the first frame after a touch, which is the one that must
    // not be late. Re-arm so it goes out now.
    if (now - lastChangeAt > IDLE_AFTER_MS) nextDue = 0;
    lastChangeAt = now;
    lastFrame = buf;
    feedNow();      // a change goes out at once rather than waiting for the next tick
  }

  // Opened once for the life of the session. See rule 3 in this file's header: a cancelled
  // screenshot stream cannot be replaced on this emulator, so nothing here ever cancels it
  // except `stop()`.
  const call = channel.client.streamScreenshot(
    { format: "RGB888", width: STREAM_BOX, height: STREAM_BOX },
    channel.metadata,
  );
  call.on("data", onFrame);
  call.on("error", (e: any) => {
    // code 1 is CANCELLED, which is how stop() ends the stream.
    if (!stopped && e?.code !== 1) {
      // The emulator died or wedged: the picture stops for good, so this is not left to viewers.
      log.error(`frame stream failed avd=${opts.emulator.avdName} grpc=${e?.code ?? "?"}: ${e?.details ?? e?.message ?? e}`);
      opts.onError(`frame stream failed: ${e?.details ?? e?.message ?? e}`);
    }
  });

  // Resolve only once the emulator has told us what it is actually sending — the session needs a
  // real geometry to put in its `ready` message, and there is nothing to guess it from.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("no frame from the emulator within 10s")), 10_000);
    const poll = setInterval(() => {
      if (geometry) { clearInterval(poll); clearTimeout(deadline); resolve(); }
      if (stopped) { clearInterval(poll); clearTimeout(deadline); reject(new Error("stopped")); }
    }, 25);
  }).catch(async (e) => {
    stopped = true;
    stopPacer();
    try { call.cancel(); } catch { /* already gone */ }
    channel.close();
    await encoder?.stop();
    throw e;
  });

  return {
    get geometry() { return geometry!; },
    encoder: encoderName,
    codecString: () => encoder?.codecString() ?? null,
    stats: () => ({ sourceFrames, fedFrames }),
    get fps() { return preset.fps; },

    setPaused(p: boolean) {
      paused = p;
      // Resuming re-arms the pacer so the first frame back is not judged against a stale deadline.
      if (!p) nextDue = 0;
    },

    async setQuality(next: AndroidQuality) {
      if (next === quality || stopped || !source) return;
      quality = next;
      preset = ANDROID_QUALITY_PRESETS[next];
      geometry = respawnEncoder(source, "quality");
      opts.onGeometry(geometry);
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      stopPacer();
      try { call.cancel(); } catch { /* already gone */ }
      channel.close();
      await encoder?.stop();
    },
  };
}
