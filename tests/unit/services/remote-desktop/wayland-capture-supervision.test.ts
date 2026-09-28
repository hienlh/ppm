/**
 * The Wayland WebRTC path runs two processes — gst-launch encoding, an ffmpeg remux publishing
 * to the relay — and the session has to end when either one dies.
 *
 * Before, only gst was watched and gst's stdout was handed straight to the remux as its stdin.
 * When the remux stalled and then died (a relay that went away mid-stream), gst kept running
 * for good, because Bun's own pump was still reading it: no `onExit`, so the viewer sat on a
 * frozen picture, and that pump's EPIPE surfaced as an unhandled rejection — three of which in
 * a minute make the server exit. These run the real `startWaylandCapture` with shell scripts
 * standing in for gst-launch and ffmpeg; only the portal (a D-Bus service) is faked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startWaylandCapture, type GstElements, type WaylandCaptureOptions,
} from "../../../../src/services/remote-desktop/remote-desktop-capture-wayland.ts";

let dir = "";
const CHUNK = 20480;

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** gst-launch at ~30 chunks a second until told to stop, which is what a live desktop does. */
const GST_FOREVER = `trap 'exit 0' INT\nwhile :; do head -c ${CHUNK} /dev/zero; sleep 0.033; done`;

function elements(launch: string): () => Promise<GstElements> {
  return async () => ({ launch, pipewiresrc: true, vapostproc: false, vah264enc: false, x264enc: true });
}

let portalStops = 0;
const startPortal = async () => {
  let closed = false;
  return {
    nodeId: 42, width: 1920, height: 1080,
    stop: () => { if (!closed) { closed = true; portalStops++; } },
    isStopped: () => closed,
  };
};

interface Run { exits: { code: number | null; reason?: string }[]; exited: Promise<void>; stop: () => void }

async function capture(gst: string, ffmpeg: string): Promise<Run> {
  const exits: Run["exits"] = [];
  let resolve!: () => void;
  const exited = new Promise<void>((r) => { resolve = r; });
  const opts: WaylandCaptureOptions = {
    session: { kind: "wayland", display: "wayland-0", runtimeDir: dir },
    publishUrl: "rtsp://127.0.0.1:1/s",
    ffmpeg,
    onExit: (code, reason) => { exits.push({ code, reason }); resolve(); },
  };
  const handle = await startWaylandCapture(opts, { startPortal, elements: elements(gst) });
  return { exits, exited, stop: handle.stop };
}

/** Fails the test instead of hanging it: the bug this guards is an `onExit` that never comes. */
function within(ms: number, p: Promise<void>): Promise<void> {
  return Promise.race([p, Bun.sleep(ms).then(() => { throw new Error(`onExit not called within ${ms} ms`); })]);
}

let rejections: unknown[] = [];
const onRejection = (e: unknown) => { rejections.push(e); };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-wayland-sup-"));
  process.on("unhandledRejection", onRejection);
});
afterEach(() => { rejections = []; portalStops = 0; });
afterAll(() => {
  process.off("unhandledRejection", onRejection);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("Wayland capture on the relay path", () => {
  it("ends the session with ffmpeg's reason when the remux stalls and dies", async () => {
    const gst = script("gst-forever", GST_FOREVER);
    // Reads for a second, stops reading (blocked on a relay that is gone), then gives up.
    const ffmpeg = script("ffmpeg-relay-dies", `timeout 1 cat >/dev/null; sleep 1; echo "rtsp://127.0.0.1:1/s: Broken pipe" >&2; exit 1`);
    const run = await capture(gst, ffmpeg);

    await within(5000, run.exited);
    await Bun.sleep(100);

    expect(run.exits).toHaveLength(1);
    expect(run.exits[0]!.reason).toContain("Broken pipe");
    expect(portalStops).toBe(1);
    expect(rejections).toEqual([]);
  }, 10_000);

  it("ends the session when the remux exits at once", async () => {
    const gst = script("gst-forever-2", GST_FOREVER);
    const ffmpeg = script("ffmpeg-refused", `head -c 4096 >/dev/null; echo "Connection refused" >&2; exit 1`);
    const run = await capture(gst, ffmpeg);

    await within(5000, run.exited);
    await Bun.sleep(100);

    expect(run.exits).toHaveLength(1);
    expect(run.exits[0]!.reason).toContain("Connection refused");
    expect(rejections).toEqual([]);
  }, 10_000);

  it("survives a remux that dies under a burst, without an unhandled EPIPE", async () => {
    // Keyframe-sized writes faster than the remux reads: the case where Bun's own pump (the old
    // `stdin: gst.stdout`) was measured throwing EPIPEs nothing could catch.
    const gst = script("gst-burst", `trap 'exit 0' INT\nwhile :; do head -c 1048576 /dev/zero; done`);
    const ffmpeg = script("ffmpeg-dies-in-burst", `head -c 65536 >/dev/null; echo "Broken pipe" >&2; exit 1`);
    const run = await capture(gst, ffmpeg);

    await within(5000, run.exited);
    await Bun.sleep(200);

    expect(run.exits).toHaveLength(1);
    expect(rejections).toEqual([]);
  }, 10_000);

  it("ends the session with gst's reason when gst dies, and takes the remux down with it", async () => {
    const gst = script("gst-dies", `head -c ${CHUNK} /dev/zero; sleep 0.3; echo "pipewiresrc0: stream error" >&2; exit 1`);
    const ffmpeg = script("ffmpeg-healthy", "exec cat >/dev/null");
    const run = await capture(gst, ffmpeg);

    await within(5000, run.exited);
    await Bun.sleep(100);

    expect(run.exits).toHaveLength(1);
    expect(run.exits[0]!.reason).toContain("stream error");
  }, 10_000);

  it("reports a deliberate stop once, with no reason", async () => {
    const gst = script("gst-forever-3", GST_FOREVER);
    const ffmpeg = script("ffmpeg-healthy-2", "exec cat >/dev/null");
    const run = await capture(gst, ffmpeg);
    await Bun.sleep(300);

    run.stop();
    await within(5000, run.exited);
    await Bun.sleep(100);

    expect(run.exits).toHaveLength(1);
    expect(run.exits[0]!.reason).toBeUndefined();
    expect(portalStops).toBe(1);
  }, 10_000);

  it("hands the remux every byte gst wrote, once", async () => {
    // A frame counter cannot see a pump that re-sends its tail (CLAUDE.md, FileSink.write);
    // only the bytes the child received can.
    const total = CHUNK * 40;
    // Writes it all, then stays up like a live pipeline until it is stopped.
    const gst = script("gst-finite", `head -c ${total} /dev/urandom\ntrap 'exit 0' INT\nwhile :; do sleep 0.05; done`);
    const out = join(dir, "remuxed.bin");
    const ffmpeg = script("ffmpeg-record", `cat > "${out}"`);
    const run = await capture(gst, ffmpeg);

    const size = () => { try { return statSync(out).size; } catch { return 0; } };
    for (let i = 0; i < 100 && size() < total; i++) await Bun.sleep(20);
    await Bun.sleep(200); // long enough for a duplicated tail to land too
    run.stop();
    await within(5000, run.exited);

    expect(size()).toBe(total);
  }, 10_000);
});
