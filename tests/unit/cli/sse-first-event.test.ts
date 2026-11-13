import { describe, test, expect } from "bun:test";
import { readSseEvent } from "../../../src/cli/utils/sse-first-event.ts";

/** A response whose body sends `chunks` one by one, then ends unless `stayOpen`. */
function sse(chunks: string[], stayOpen = false): { res: Response; cancelled: () => boolean } {
  let cancelled = false;
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]!));
      else if (!stayOpen) controller.close();
      else return new Promise(() => {}); // a stream that never sends again
    },
    cancel() { cancelled = true; },
  });
  return { res: new Response(body), cancelled: () => cancelled };
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const SESSION = frame("session", { sid: "abcd1234", tier: "full", intervalMs: 2000 });

describe("readSseEvent", () => {
  test("answers the n-th accepted frame and ends the session on the server", async () => {
    const released: string[] = [];
    const { res, cancelled } = sse([
      "retry: 5000\n\n", SESSION, frame("snapshot", { ts: 5 }), frame("snapshot", { ts: 10 }), frame("snapshot", { ts: 12 }),
    ], true); // a live stream: still open when the answer is in, so the reader must close it
    const got = await readSseEvent<{ ts: number }>(res, "snapshot", 2, 5000, {
      accept: (s) => s.ts > 5, // the cached snapshot a new stream answers first does not count
      release: async (sid) => { released.push(sid); },
    });
    expect(got.ts).toBe(12);
    expect(released).toEqual(["abcd1234"]);
    expect(cancelled()).toBe(true);
  });

  test("a frame split across chunks, and CRLF line ends, are read whole", async () => {
    const whole = SESSION + frame("snapshot", { ts: 7, text: "a" });
    const { res } = sse([whole.slice(0, 30), whole.slice(30, 61).replace(/\n/g, "\r\n"), whole.slice(61)]);
    expect((await readSseEvent<{ ts: number }>(res, "snapshot", 1, 5000)).ts).toBe(7);
  });

  test("a time-out still ends the session", async () => {
    const released: string[] = [];
    const { res, cancelled } = sse([SESSION], true);
    await expect(readSseEvent(res, "snapshot", 1, 50, { release: async (sid) => { released.push(sid); } }))
      .rejects.toThrow("No snapshot arrived within");
    expect(released).toEqual(["abcd1234"]);
    expect(cancelled()).toBe(true);
  });

  test("an error frame from the server is the error, and the session is ended", async () => {
    const released: string[] = [];
    const { res } = sse([SESSION, frame("error", { error: "Too many metrics subscribers" })], true);
    await expect(readSseEvent(res, "snapshot", 1, 5000, { release: async (sid) => { released.push(sid); } }))
      .rejects.toThrow("Too many metrics subscribers");
    expect(released).toEqual(["abcd1234"]);
  });

  test("a stream that ends early says so; one that never sent a session releases nothing", async () => {
    const released: string[] = [];
    const { res } = sse([frame("snapshot", { ts: 1 })]);
    await expect(readSseEvent(res, "snapshot", 2, 5000, { release: async (sid) => { released.push(sid); } }))
      .rejects.toThrow("The stream ended before 2 snapshot frames arrived");
    expect(released).toEqual([]);
  });

  test("a release that fails does not hide the answer", async () => {
    const { res } = sse([SESSION, frame("snapshot", { ts: 3 })]);
    const got = await readSseEvent<{ ts: number }>(res, "snapshot", 1, 5000, { release: async () => { throw new Error("gone"); } });
    expect(got.ts).toBe(3);
  });
});
