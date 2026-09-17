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

export async function downloadVerified(opts: DownloadOptions): Promise<void> {
  const { url, dest, sha256, onProgress, signal } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const part = `${dest}.part`;

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(part, { force: true });

  const res = await fetchFn(url, { redirect: "follow", signal });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (${url})`);
  if (!res.body) throw new Error(`download failed: empty body (${url})`);

  const total = Number(res.headers.get("content-length") ?? 0) || 0;
  const hash = createHash("sha256");
  const sink = Bun.file(part).writer();
  let received = 0;

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      sink.write(chunk);
      received += chunk.byteLength;
      onProgress?.(received, total);
    }
    await sink.end();
  } catch (e) {
    try {
      await sink.end();
    } catch {
      // Sink already torn down by the failure itself.
    }
    rmSync(part, { force: true });
    throw e;
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
