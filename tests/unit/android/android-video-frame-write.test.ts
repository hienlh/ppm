/**
 * The raw frames PPM hands ffmpeg have to arrive byte for byte, in order, once each.
 *
 * This exists because a frame *counter* cannot see the bug it pins. The write path used to loop
 * `off += sink.write(frame.subarray(off))`, which reads like careful handling of a partial write
 * and is not: `FileSink.write()` consumes the whole chunk and returns a number that means
 * something else, so the loop re-sent the tail over and over. Every frame was fed exactly once
 * by every counter in the pipeline while ffmpeg received 5.7x the bytes — its rawvideo stream
 * offset permanently, the first picture perfect and every one after it drawn rolled.
 *
 * So the assertion is on the bytes a real child process receives, not on calls made.
 */
import { describe, it, expect } from "bun:test";
import { writeFrameToSink } from "../../../src/services/android/android-video.ts";

/** Big enough that the sink buffers in several pieces — that is the whole hazard. */
const FRAME_BYTES = 1600 * 1026 * 3;   // 4,924,800: the size measured when this was found

/** `cat`, as a bun child so that it exists on Windows too: stdin copied to stdout, unchanged. */
const COPY_STDIN_TO_STDOUT =
  "const out = Bun.stdout.writer(); for await (const chunk of Bun.stdin.stream()) { out.write(chunk); await out.flush(); } await out.end();";

describe("raw frame write path", () => {
  it("delivers each frame exactly once, in order, byte for byte", async () => {
    const markers = [0x11, 0x22, 0x33];
    const proc = Bun.spawn([process.execPath, "-e", COPY_STDIN_TO_STDOUT], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });

    let received = 0;
    const seen: Array<{ at: number; byte: number }> = [];
    const reader = proc.stdout.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) return;
        // Record the byte sitting at each frame boundary as it goes past.
        for (const boundary of [0, FRAME_BYTES, FRAME_BYTES * 2]) {
          if (boundary >= received && boundary < received + value.length) {
            seen.push({ at: boundary, byte: value[boundary - received]! });
          }
        }
        received += value.length;
      }
    })();

    for (const m of markers) {
      await writeFrameToSink(proc.stdin as never, Buffer.alloc(FRAME_BYTES, m));
    }
    proc.stdin.end();
    await pump;
    await proc.exited;

    expect(received).toBe(FRAME_BYTES * markers.length);
    // Each frame starts where it should, so nothing was duplicated or dropped ahead of it.
    expect(seen.map((s) => s.byte)).toEqual(markers);
  });

  it("returns only once the sink has taken the frame", async () => {
    const order: string[] = [];
    const sink = {
      write: () => { order.push("write"); return 1; },
      flush: async () => { await Bun.sleep(5); order.push("flush"); },
    };
    await writeFrameToSink(sink, new Uint8Array(4));
    expect(order).toEqual(["write", "flush"]);
  });
});
