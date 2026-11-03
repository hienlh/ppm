/**
 * Scans of transcripts, kept per file and brought up to date by reading only what was appended.
 *
 * A transcript normally only grows, so a scan resumes at the offset it stopped at. But it is not
 * always append-only: stripping images rewrites it in place under the same inode
 * (`transcript-images-file.ts`), and a rewrite that shrinks then grows past the old size would
 * leave the size check satisfied while every stored offset points into different records. So the
 * 4 KB before the resume offset is hashed when the scan stops and hashed again before resuming;
 * any difference throws the scan away and starts over.
 *
 * Two requests for the same file while it is being scanned share one walk (the lesson of
 * `historyInFlight` in `routes/chat.ts`: a client cannot cancel a parse, so concurrent asks must
 * not each start one). The cache holds at most `maxEntries` files and `maxBytes` of estimated
 * state, least recently used dropped first.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

const FINGERPRINT_BYTES = 4096;

export interface ScanEntry<S> {
  path: string;
  size: number;
  mtimeMs: number;
  /** Where the scan stopped: the end of the last complete line. */
  offset: number;
  fingerprint: string;
  state: S;
  bytes: number;
  /** Bumped on every change of `state`, so a reader can tell two snapshots apart. */
  version: number;
}

export interface TurnIndexCacheOptions<S> {
  newState(): S;
  /** Scans from `fromByte` into `state` (mutating it); returns the new resume offset. */
  scan(path: string, state: S, fromByte: number): Promise<number>;
  /** Estimated bytes held by `state`. */
  sizeOf(state: S): number;
  maxEntries?: number;
  maxBytes?: number;
}

/** Hash of the bytes just before `offset` — what must not change for a resume to be safe. */
export async function fingerprintAt(path: string, offset: number): Promise<string> {
  const from = Math.max(0, offset - FINGERPRINT_BYTES);
  const buf = new Uint8Array(offset - from);
  const handle = await open(path, "r");
  try {
    const { bytesRead } = await handle.read(buf, 0, buf.length, from);
    return createHash("sha1").update(buf.subarray(0, bytesRead)).update(String(offset)).digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

export class TurnIndexCache<S> {
  private readonly entries = new Map<string, ScanEntry<S>>();
  private readonly inFlight = new Map<string, Promise<ScanEntry<S>>>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: TurnIndexCacheOptions<S>) {
    this.maxEntries = opts.maxEntries ?? 200;
    this.maxBytes = opts.maxBytes ?? 48 * 1024 * 1024;
  }

  /** The scan of `path` as the file is now. Throws when the file cannot be read. */
  async get(path: string): Promise<ScanEntry<S>> {
    const { size, mtimeMs } = await stat(path);
    const entry = this.entries.get(path);
    if (entry && entry.size === size && entry.mtimeMs === mtimeMs) {
      this.touch(entry);
      return entry;
    }
    const running = this.inFlight.get(path);
    if (running) return running;
    const build = this.refresh(path, entry, size, mtimeMs).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, build);
    return build;
  }

  /** Forget a file's scan, so the next `get` starts over. */
  invalidate(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.totalBytes -= entry.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  private async refresh(path: string, previous: ScanEntry<S> | undefined, size: number, mtimeMs: number): Promise<ScanEntry<S>> {
    const resumable = previous && size >= previous.offset
      && await fingerprintAt(path, previous.offset).catch(() => "") === previous.fingerprint;
    if (previous) this.invalidate(path);
    const state = resumable ? previous!.state : this.opts.newState();
    const offset = await this.opts.scan(path, state, resumable ? previous!.offset : 0);
    const entry: ScanEntry<S> = {
      path, size, mtimeMs, offset, state,
      fingerprint: await fingerprintAt(path, offset),
      bytes: this.opts.sizeOf(state),
      version: (previous?.version ?? 0) + 1,
    };
    this.entries.set(path, entry);
    this.totalBytes += entry.bytes;
    this.evict(entry);
    return entry;
  }

  private touch(entry: ScanEntry<S>): void {
    this.entries.delete(entry.path);
    this.entries.set(entry.path, entry);
  }

  /** Drop the least recently used scans until both bounds hold; never the one just stored. */
  private evict(keep: ScanEntry<S>): void {
    for (const [path, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) return;
      if (entry === keep) continue;
      this.entries.delete(path);
      this.totalBytes -= entry.bytes;
    }
  }
}
