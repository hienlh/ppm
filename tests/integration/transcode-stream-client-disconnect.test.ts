import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTranscodeCount, startTranscode, stopTranscode } from "../../src/services/media-transcode/transcode-stream.ts";
import { getFfmpegCapabilities } from "../../src/services/media-transcode/ffmpeg-capabilities.ts";

/**
 * ffmpeg lifetime under the two ways a player goes away:
 *  - the connection drops (direct access) — must kill the job and must not take the server
 *    down: Bun 1.3.x on Windows segfaults when a subprocess stdout is handed to `Response`
 *    directly or its reader is cancelled, and a crash shows up here as the test process dying;
 *  - the connection stays open (Cloudflare Tunnel keeps draining the body) — the job must
 *    still be replaced on the next seek for the same player and stop on explicit request.
 */
const caps = await getFfmpegCapabilities();
const hasFfmpeg = Boolean(caps.ffmpeg && caps.encoder);

let dir = "";
let src = "";

async function waitIdle() {
  for (let i = 0; i < 20 && activeTranscodeCount() > 0; i++) await Bun.sleep(100);
}

describe.skipIf(!hasFfmpeg)("startTranscode lifecycle", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "transcode-dc-"));
    src = join(dir, "src.avi");
    // A short synthetic MJPEG AVI: the same shape as a camera file, no fixture needed.
    const gen = Bun.spawn(
      [caps.ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=20",
        "-c:v", "mjpeg", "-q:v", "5", src],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await gen.exited).toBe(0);
  });

  afterAll(async () => {
    await waitIdle();
    // Windows keeps the input handle open for a few ms after a kill → EBUSY on the first rm.
    for (let i = 0; i < 20; i++) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch { await Bun.sleep(100); }
    }
  });

  it("kills ffmpeg, releases the slot and survives repeated client disconnects", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const job = await startTranscode(src, { start: 2, signal: req.signal });
        return new Response(job.stream, { headers: { "Content-Type": "video/mp4" } });
      },
    });
    try {
      for (let round = 0; round < 3; round++) {
        const ac = new AbortController();
        const res = await fetch(`http://localhost:${server.port}/`, { signal: ac.signal });
        const reader = res.body!.getReader();
        expect((await reader.read()).value?.length).toBeGreaterThan(0);
        ac.abort();
        await reader.read().catch(() => undefined);
        await waitIdle();
        expect(activeTranscodeCount()).toBe(0);
      }
    } finally {
      server.stop(true);
    }
  }, 30_000);

  it("replaces a player's previous job on the same session id and stops it on request", async () => {
    // Nothing here aborts a stream — this is the proxy-that-never-disconnects case.
    const first = await startTranscode(src, { start: 1, sessionId: "player-a" });
    const firstReader = first.stream.getReader();
    expect((await firstReader.read()).value?.length).toBeGreaterThan(0);
    expect(activeTranscodeCount()).toBe(1);

    // Seek: same player, new job → the old one dies although its stream was never cancelled.
    const second = await startTranscode(src, { start: 5, sessionId: "player-a" });
    const secondReader = second.stream.getReader();
    expect((await secondReader.read()).value?.length).toBeGreaterThan(0);
    expect(activeTranscodeCount()).toBe(1);
    const firstEnd = await firstReader.read().catch(() => ({ done: true, value: undefined }));
    expect(firstEnd.done).toBe(true);

    // Unmount: explicit stop frees the slot; a second stop reports nothing to do.
    expect(stopTranscode("player-a")).toBe(true);
    expect(stopTranscode("player-a")).toBe(false);
    await waitIdle();
    expect(activeTranscodeCount()).toBe(0);
  }, 30_000);
});
