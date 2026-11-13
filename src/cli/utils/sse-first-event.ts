/**
 * Reads what a `ppm` command needs from a server-sent-events stream (the Task Manager's metrics
 * stream), then lets go of it: the n-th accepted frame of one event type, within a time limit.
 *
 * The stream's first frame is `session` (`{sid}`); whatever happens — the frame arrives, the time
 * runs out, the server sends `error`, the stream ends early — `release(sid)` is called before the
 * answer, so the command leaves no subscriber behind on the server (a dropped connection alone is
 * only noticed when the lease runs out).
 */

export interface SseFrame { event: string; data: string }

/** One read of the stream: a chunk, or the end. */
type ReadChunk = () => Promise<{ value?: Uint8Array; done: boolean }>;

/** Splits a stream into its frames (`event:` + `data:` lines up to a blank line). */
export async function* sseFrames(next: ReadChunk): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await next();
    if (done || !value) return;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
    }
  }
}

export interface ReadSseOptions<T> {
  /** Only frames this accepts count toward `n` (e.g. a snapshot newer than the cached one). */
  accept?: (data: T) => boolean;
  /** Ends the stream's session on the server; called once, with the `session` frame's `sid`. */
  release?: (sid: string) => Promise<void>;
}

/** The `n`-th (1-based) accepted `event` frame of `res`, parsed as JSON. */
export async function readSseEvent<T>(res: Response, event: string, n: number, timeoutMs: number, opts: ReadSseOptions<T> = {}): Promise<T> {
  if (!res.body) throw new Error("The server answered without a stream");
  const reader = res.body.getReader();
  let sid: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${event} arrived within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  const next: ReadChunk = () => Promise.race([reader.read(), expired]);
  try {
    let seen = 0;
    for await (const frame of sseFrames(next)) {
      const data = JSON.parse(frame.data) as unknown;
      if (frame.event === "session") {
        const id = (data as { sid?: unknown })?.sid;
        if (typeof id === "string") sid = id;
      } else if (frame.event === "error") {
        throw new Error((data as { error?: string })?.error ?? "The stream reported an error");
      } else if (frame.event === event && (!opts.accept || opts.accept(data as T)) && ++seen >= n) {
        return data as T;
      }
    }
    throw new Error(`The stream ended before ${n > 1 ? `${n} ${event} frames` : `a ${event}`} arrived`);
  } finally {
    clearTimeout(timer);
    expired.catch(() => {});
    await reader.cancel().catch(() => {});
    if (sid && opts.release) await opts.release(sid).catch(() => {});
  }
}
