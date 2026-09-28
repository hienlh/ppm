/**
 * Streaming download with a SHA-256 gate.
 *
 * A model is 574 MB, so it is hashed while it streams rather than read back
 * afterwards, and it lands on a `.part` file that is only renamed once the hash
 * matches: an interrupted or tampered download can never be mistaken for an
 * installed one, and a retry starts clean.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type FetchFn = typeof fetch;

export interface DownloadOptions {
  url: string;
  dest: string;
  /** Lowercase hex. The download is discarded when the bytes hash to anything else. */
  sha256: string;
  /** Called as bytes arrive; `total` is 0 when the server sends no Content-Length. */
  onProgress?: (received: number, total: number) => void;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
}

/**
 * How long the transfer may produce no bytes at all before it is abandoned.
 *
 * Idle rather than wall-clock: the largest model here is 574 MB, and any total-time
 * bound that a slow line can exceed would abort a download that was working. What is
 * never legitimate is silence — a half-open socket after a dropped wifi link or a
 * tunnel that went away never errors and never yields, so without this the `for await`
 * below simply never returns and the install never settles.
 */
const STALL_TIMEOUT_MS = 60_000;

export async function downloadVerified(opts: DownloadOptions): Promise<void> {
  const { url, dest, sha256, onProgress, signal } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const part = `${dest}.part`;

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(part, { force: true });

  // The caller's signal and the stall timer both have to reach the body stream, and
  // `fetch` takes one signal — so an internal controller carries both.
  const stall = new AbortController();
  const forwardAbort = () => stall.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armStallTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => stall.abort(new Error(`download stalled: no bytes for ${STALL_TIMEOUT_MS}ms (${url})`)),
      STALL_TIMEOUT_MS,
    );
    timer.unref?.();
  };
  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    signal?.removeEventListener("abort", forwardAbort);
  };

  let res: Response;
  armStallTimer();
  try {
    res = await fetchFn(url, { redirect: "follow", signal: stall.signal });
  } catch (e) {
    disarm();
    throw stall.signal.aborted && stall.signal.reason instanceof Error ? stall.signal.reason : e;
  }
  if (!res.ok) { disarm(); throw new Error(`download failed: HTTP ${res.status} (${url})`); }
  if (!res.body) { disarm(); throw new Error(`download failed: empty body (${url})`); }

  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const hash = createHash("sha256");
  const sink = Bun.file(part).writer();
  let received = 0;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      armStallTimer();
      hash.update(chunk);
      sink.write(chunk);
      received += chunk.byteLength;
      onProgress?.(received, total);
    }
    await sink.end();
    disarm();
  } catch (e) {
    disarm();
    try {
      await sink.end();
    } catch {
      // Sink already torn down by the failure itself.
    }
    rmSync(part, { force: true });
    // An abort raised by the stall timer carries the reason worth reporting; the
    // stream's own `AbortError` says only that somebody cancelled.
    throw stall.signal.aborted && stall.signal.reason instanceof Error ? stall.signal.reason : e;
  }

  const actual = hash.digest("hex");
  if (actual !== sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
  }

  // Windows refuses a rename onto an existing file, so clear the target first.
  rmSync(dest, { force: true });
  renameSync(part, dest);
}
