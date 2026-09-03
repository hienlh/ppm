import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTranscodeCount, startTranscode } from "../../src/services/media-transcode/transcode-stream.ts";
import { getFfmpegCapabilities } from "../../src/services/media-transcode/ffmpeg-capabilities.ts";

/**
 * A client that drops a transcode mid-stream (seek, tab closed) must kill ffmpeg and must
 * not take the server down. Bun 1.3.x on Windows segfaults when a subprocess stdout is
 * handed to `Response` directly or when its reader is cancelled; a crash here shows up as
 * the whole test process dying, which is exactly the regression this guards against.
 */
const caps = await getFfmpegCapabilities();
const hasFfmpeg = Boolean(caps.ffmpeg && caps.encoder);

describe.skipIf(!hasFfmpeg)("startTranscode — client disconnect", () => {
  it("kills ffmpeg, releases the slot and keeps the process alive across repeated aborts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcode-dc-"));
    const src = join(dir, "src.avi");
    // A short synthetic MJPEG AVI: the same shape as a camera file, no fixture needed.
    const gen = Bun.spawn(
      [caps.ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=20",
        "-c:v", "mjpeg", "-q:v", "5", src],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await gen.exited).toBe(0);

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
        let bytes = 0;
        const first = await reader.read();
        bytes += first.value?.length ?? 0;
        expect(bytes).toBeGreaterThan(0);
        ac.abort();
        await reader.read().catch(() => undefined);
        // Give the cancel → kill → exited chain a moment to settle.
        for (let i = 0; i < 20 && activeTranscodeCount() > 0; i++) await Bun.sleep(100);
        expect(activeTranscodeCount()).toBe(0);
      }
    } finally {
      server.stop(true);
      // Windows keeps the input handle open for a few ms after the kill → EBUSY on the first rm.
      for (let i = 0; i < 20; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { await Bun.sleep(100); }
      }
    }
  }, 30_000);
});
