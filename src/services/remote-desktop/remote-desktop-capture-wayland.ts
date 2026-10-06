/**
 * Wayland screen capture: `gst-launch-1.0` reading the desktop portal's PipeWire node.
 *
 * This is a second capture backend beside the ffmpeg one in `remote-desktop-capture.ts`, not a
 * variant of it, and the split is forced rather than chosen: ffmpeg can only read PipeWire if it
 * was built `--enable-libpipewire`, which distributions overwhelmingly do not do (Arch's own
 * `ffmpeg 2:9.0.1-4.1` does not, so `pipewiregrab` is absent on the host this was written on).
 * GStreamer's `pipewiresrc` ships in a small separate package that a desktop usually already
 * has. It is also exactly what RustDesk does — `Depends On: gst-plugins-base gst-plugin-pipewire`
 * — so this is the well-trodden path, not a workaround.
 *
 * The output is byte-identical to the ffmpeg backend's: H.264 Annex-B access units on stdout.
 * Everything downstream — the access-unit assembler, the WebSocket transport, the MediaMTX
 * relay, the quality ladder — is untouched and cannot tell the two apart.
 *
 * Three measured details are encoded here, each of which fails silently if changed:
 *
 * - **The frame rate is capped by a capsfilter, never by `videorate max-rate=`.** Measured: with
 *   `max-rate=30` the pipeline delivered 59 fps, and with `max-rate=60` it delivered 133 — the
 *   property does not cap, it only hints. `videorate ! video/x-raw,framerate=30/1` caps for real.
 * - **That same capsfilter is what makes an idle desktop watchable.** A portal stream is
 *   damage-driven: on a still screen the compositor pushed **14 frames in 60 seconds**, so a
 *   viewer joining a quiet host would see nothing at all until something moved. `videorate`
 *   duplicates the last frame to hold cadence — measured 29.6 fps on a completely static screen
 *   — which also means keyframes keep arriving, so a late joiner syncs within one GOP.
 * - **`vapostproc` does the colour conversion on the GPU and it is worth the branch.** The
 *   portal hands out BGRA; converting that to NV12 in software cost 52% of a core at 1080p,
 *   against 14.9% for the whole GPU pipeline at the same resolution and a 30 fps cap.
 */
import { CaptureUnavailableError, type CaptureHandle, type StartCaptureOptions } from "./remote-desktop-capture.ts";
import { AccessUnitAssembler } from "./access-unit-assembler.ts";
import { DEFAULT_FPS, type QualityPreset } from "../../shared/remote-desktop-quality.ts";
import { startPortalScreenCast, type PortalScreenCast } from "./remote-desktop-portal.ts";
import { linuxSessionEnv, type LinuxSession } from "./remote-desktop-linux-session.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("remote-desktop");

/** Which GStreamer elements this host actually has. Probed once — `gst-inspect-1.0` is ~40 ms
 *  and this sits on the session-start path. */
export interface GstElements {
  /** `gst-launch-1.0` itself. */
  launch: string | null;
  /** The portal source. Without it there is no Wayland capture at all. */
  pipewiresrc: boolean;
  /** GPU colour conversion; falls back to `videoconvert` on the CPU. */
  vapostproc: boolean;
  /** Hardware H.264; falls back to `x264enc`. */
  vah264enc: boolean;
  x264enc: boolean;
}

let cachedElements: GstElements | null = null;

async function hasElement(name: string): Promise<boolean> {
  try {
    const probe = Bun.spawn(["gst-inspect-1.0", name], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
    });
    return (await probe.exited) === 0;
  } catch {
    return false;
  }
}

export async function gstElements(force = false): Promise<GstElements> {
  if (cachedElements && !force) return cachedElements;
  const launch = Bun.which("gst-launch-1.0");
  if (!launch) {
    cachedElements = { launch: null, pipewiresrc: false, vapostproc: false, vah264enc: false, x264enc: false };
    return cachedElements;
  }
  const [pipewiresrc, vapostproc, vah264enc, x264enc] = await Promise.all([
    hasElement("pipewiresrc"),
    hasElement("vapostproc"),
    hasElement("vah264enc"),
    hasElement("x264enc"),
  ]);
  cachedElements = { launch, pipewiresrc, vapostproc, vah264enc, x264enc };
  return cachedElements;
}

/** Drop the probe cache, so a package installed while PPM is running is picked up. */
export function _resetGstElements(): void {
  cachedElements = null;
}

/** `"4M"` / `"1500k"` / `"800000"` → kbps, which is what every GStreamer encoder takes.
 *  ffmpeg's string form is kept in `QualityPreset` because the ffmpeg backend passes it
 *  straight through; this is the one place it has to be understood. */
export function bitrateKbps(bitrate: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(bitrate.trim());
  if (!m) return 1_000;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const kbps = unit === "m" ? n * 1_000 : unit === "k" ? n : n / 1_000;
  // vah264enc rejects 0 outright, the same way ffmpeg does.
  return Math.max(1, Math.round(kbps));
}

/**
 * The capture pipeline as an argv. Pure, so the element choices and the frame-rate cap can be
 * asserted without a compositor, a GPU or a portal.
 */
export function buildWaylandCaptureArgs(
  nodeId: number,
  els: GstElements,
  preset: QualityPreset = { fps: DEFAULT_FPS, bitrate: "1M" },
): string[] {
  const fps = Math.max(1, Math.round(preset.fps || DEFAULT_FPS));
  const kbps = bitrateKbps(preset.bitrate);
  const launch = els.launch ?? "gst-launch-1.0";

  // GPU path: vapostproc converts into VA memory that vah264enc encodes from without ever
  // touching system RAM. Mixing the two halves (vapostproc + x264enc) would download the frame
  // again, so the conversion follows the encoder rather than being chosen on its own.
  const gpu = els.vapostproc && els.vah264enc;
  const convert = gpu
    ? ["vapostproc", "!", "video/x-raw(memory:VAMemory),format=NV12"]
    : ["videoconvert", "!", "video/x-raw,format=I420"];
  const encode = gpu
    ? ["vah264enc", `bitrate=${kbps}`, `key-int-max=${fps}`]
    // `tune=zerolatency` + `speed-preset=veryfast` are x264enc's equivalents of what
    // `captureEncoderArgs` passes ffmpeg; without them the software path buffers whole
    // B-frame groups and the felt lag doubles.
    : ["x264enc", `bitrate=${kbps}`, `key-int-max=${fps}`, "tune=zerolatency", "speed-preset=veryfast"];

  return [
    launch, "-q",
    "pipewiresrc", `path=${nodeId}`,
    "!", "video/x-raw",
    // Load-bearing twice over: caps the rate (max-rate= does not), and duplicates the last
    // frame on a still screen so a late viewer is not left with a blank canvas. See the header.
    "!", "videorate",
    "!", `video/x-raw,framerate=${fps}/1`,
    "!", ...convert,
    "!", ...encode,
    "!", "h264parse",
    // Annex-B with one buffer per access unit — exactly the shape `AccessUnitAssembler` and the
    // RTSP remux both expect, and the same bytes ffmpeg's `-f h264 pipe:1` produces.
    "!", "video/x-h264,stream-format=byte-stream,alignment=au",
    "!", "fdsink", "fd=1",
  ];
}

/** ffmpeg's half of the WebRTC path: it only remuxes, never re-encodes, so this costs almost
 *  nothing. GStreamer would do it in-process with `rtspclientsink`, but that element lives in
 *  `gst-rtsp-server` which is a far less common package than `gst-plugin-pipewire` — requiring
 *  it would turn a working host into an unmet requirement for no gain. */
export function buildWaylandPublishArgs(ffmpeg: string, publishUrl: string): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-f", "h264", "-i", "pipe:0",
    "-c:v", "copy",
    "-flush_packets", "1",
    "-f", "rtsp", "-rtsp_transport", "tcp", publishUrl,
  ];
}

export interface WaylandCaptureOptions extends StartCaptureOptions {
  session: LinuxSession & { kind: "wayland" };
  /** ffmpeg path, needed only for the RTSP remux on the WebRTC path. */
  ffmpeg?: string | null;
}

/** What a test stands in for: the portal is a D-Bus service, and the element probe resolves
 *  through the PATH this process started with, which a test cannot change. */
export interface WaylandCaptureDeps {
  startPortal?: typeof startPortalScreenCast;
  elements?: () => Promise<GstElements>;
}

/**
 * Start Wayland capture. The portal session is opened first and torn down last: the PipeWire
 * node belongs to the D-Bus connection that asked for it, so closing it before GStreamer has
 * exited pulls the source out from under a running pipeline.
 */
export async function startWaylandCapture(
  opts: WaylandCaptureOptions,
  { startPortal = startPortalScreenCast, elements = gstElements }: WaylandCaptureDeps = {},
): Promise<CaptureHandle> {
  const els = await elements();
  if (!els.launch) {
    throw new CaptureUnavailableError("gst-launch-1.0 is not installed (Wayland capture needs GStreamer)");
  }
  if (!els.pipewiresrc) {
    throw new CaptureUnavailableError("the GStreamer PipeWire plugin is missing (gst-plugin-pipewire)");
  }
  if (!els.vah264enc && !els.x264enc) {
    throw new CaptureUnavailableError("no GStreamer H.264 encoder (install gst-plugins-ugly for x264enc)");
  }

  const publishUrl = opts.publishUrl ?? null;
  if (!publishUrl && !opts.onAccessUnit) {
    throw new CaptureUnavailableError("startWaylandCapture needs either onAccessUnit or publishUrl");
  }

  let portal: PortalScreenCast;
  try {
    portal = await startPortal({ drawMouse: opts.drawMouse ?? true });
  } catch (e) {
    // A dismissed dialog or a missing portal is an unmet requirement, not a crash — surface the
    // portal's own wording, which already says which of the two it was.
    throw new CaptureUnavailableError((e as Error).message);
  }

  const env = { ...process.env, ...linuxSessionEnv(opts.session) };
  const argv = buildWaylandCaptureArgs(portal.nodeId, els, opts.preset);
  const gst = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });

  // On the WebRTC path a second process remuxes GStreamer's Annex-B into RTSP, and PPM carries
  // the bytes between the two itself (the pump below). Handing `gst.stdout` over as the remux's
  // stdin looks like a pipe between two children and is not one: measured, Bun reads every byte
  // into this process and writes it back out with a pump of its own. When the remux dies, that
  // pump rejects with an EPIPE nothing can catch — three of those in a minute make the server
  // exit (`handleFatalError`) — and gst, still being read, never learns it lost its reader.
  const remux = publishUrl && opts.ffmpeg
    ? Bun.spawn(buildWaylandPublishArgs(opts.ffmpeg, publishUrl), {
      stdin: "pipe", stdout: "ignore", stderr: "pipe", env,
    })
    : null;
  if (publishUrl && !remux) {
    gst.kill("SIGKILL");
    portal.stop();
    throw new CaptureUnavailableError("ffmpeg is needed to publish the Wayland stream to the relay");
  }
  // Never the argv: on the relay path it carries the publish URL, whose path is the stream secret.
  log.info(
    `wayland capture started gst=${gst.pid} node=${portal.nodeId} ` +
    `enc=${els.vapostproc && els.vah264enc ? "vah264enc" : "x264enc"} fps=${opts.preset?.fps ?? DEFAULT_FPS} ` +
    `kbps=${bitrateKbps(opts.preset?.bitrate ?? "1M")} remux=${remux?.pid ?? "none"} reason=${opts.reason ?? "start"}`,
  );

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // gst-launch answers SIGINT with a clean EOS; the relay half is a plain remux and can be
    // killed outright. The portal session goes last, after both readers are gone.
    if (!gst.killed) gst.kill("SIGINT");
    if (remux && !remux.killed) remux.kill("SIGKILL");
    portal.stop();
  };

  // The first process to exit without being asked decides what the session is told, and takes
  // the other one down with it: a dead remux leaves gst encoding for nobody, a dead gst leaves
  // the remux publishing nothing. Either way the viewer would sit on a frozen picture.
  const tail = (text: string) => text.trim().split("\n").slice(-3).join(" | ");
  const gstErr = new Response(gst.stderr).text().catch(() => "");
  const remuxErr = remux ? new Response(remux.stderr).text().catch(() => "") : Promise.resolve("");
  let failure: Promise<{ code: number | null; reason?: string }> | null = null;
  gst.exited.then((code) => {
    if (stopped) { log.debug(`gst-launch pid=${gst.pid} stopped`); return; }
    const unexpected = (text: string) =>
      log.error(`gst-launch pid=${gst.pid} exited unexpectedly code=${gst.exitCode} signal=${gst.signalCode}: ${text || "(no stderr)"}`);
    failure = (async () => {
      // A clean exit is the portal or the compositor ending the stream: still the end of the
      // session, so it is logged too — without holding up `onExit` for the stderr read.
      if (code === 0 || code === null) { void gstErr.then((t) => unexpected(tail(t))); return { code }; }
      const reason = tail(await gstErr);
      unexpected(reason);
      return { code, reason };
    })();
    stop();
  });
  remux?.exited.then((code) => {
    if (stopped) { log.debug(`relay remux pid=${remux.pid} stopped`); return; }
    failure = (async () => {
      // Any exit nobody asked for is a failure here, a clean one included: it means the relay
      // stopped taking the stream.
      const stderr = tail(await remuxErr);
      const reason = stderr || `the relay publisher exited with code ${code}`;
      // ffmpeg names the URL it failed to push to, and that URL's path is the stream secret.
      // Matched only when long: a real one is `randomStreamPath`'s 33 characters, and a short
      // one would replace every occurrence of some ordinary letter.
      const streamPath = publishUrl ? publishUrl.slice(publishUrl.lastIndexOf("/") + 1) : "";
      const logged = streamPath.length >= 16 ? stderr.split(streamPath).join("[path]") : stderr;
      log.error(`relay remux pid=${remux.pid} exited unexpectedly code=${remux.exitCode} signal=${remux.signalCode}: ${logged || "(no stderr)"}`);
      return { code, reason };
    })();
    stop();
  });
  // Reported once both are gone, so a respawn waiting on it never overlaps the next capture
  // with a process left over from this one.
  void Promise.all([gst.exited, remux?.exited]).then(async ([gstCode]) => {
    portal.stop();
    const failed = failure ? await failure : null;
    opts.onExit?.(failed ? failed.code : gstCode, failed?.reason);
  });

  if (remux) {
    // One write and one flush per chunk, both awaited: an unawaited write that meets a dead
    // remux rejects with nobody to catch it, which is the failure this pump exists to avoid.
    // Never a cancel, for the same reason as the pull loop below.
    const source = gst.stdout.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await source.read();
        if (done) break;
        if (!value) continue;
        await remux.stdin.write(value);
        await remux.stdin.flush();
      }
      await remux.stdin.end();
    })().catch((e) => {
      // The remux is gone, and its exit above is what reports it. Kill it anyway: a pump that
      // failed with the remux still running would leave gst blocked on a full pipe forever.
      log.debug(`relay remux pump ended: ${(e as Error)?.message ?? e}`);
      try { remux.kill("SIGKILL"); } catch { /* already gone */ }
    });
    return { pid: gst.pid, cachedSps: () => null, stop, isStopped: () => stopped };
  }

  const assembler = new AccessUnitAssembler();
  const onAccessUnit = opts.onAccessUnit!;
  // Manual pull loop, never a cancel — same constraint as the ffmpeg backend (see that file's
  // header: cancelling this reader segfaults Bun on Windows, and the shape must not diverge).
  const reader = gst.stdout.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      for (const au of assembler.push(value)) onAccessUnit(au);
    }
  })().catch((e) => {
    log.error(`wayland capture pump failed: ${(e as Error).message}`);
  });

  return { pid: gst.pid, cachedSps: () => assembler.cachedSps(), stop, isStopped: () => stopped };
}
