import { open } from "node:fs/promises";

/**
 * A file's bytes, a piece at a time, through `node:fs/promises` — never `Bun.file().stream()`.
 *
 * On Bun 1.3.10 (Windows), every full read through `Bun.file(path).stream()` keeps roughly the
 * file's size in native memory that is never handed back: a 30 MB transcript read 40 times took
 * a process from 377 MB to 1,949 MB private, 38 MB a read, with the JS heap back at 18 MB. A
 * chat tab opening reads the whole transcript this way (`readCompactions`), so a server whose
 * tabs reconnected all day reached 25 GB committed and the machine ran out of memory. The same
 * 40 reads through a `FileHandle` stayed flat (0.1 MB a read); so did `createReadStream` and
 * `readSync`. Measured as private bytes (commit charge), which RSS and the heap both hide.
 *
 * Each chunk is a fresh buffer, so a caller may keep it after asking for the next one. Breaking
 * out of the loop closes the file (the generator's `finally`), so an early stop leaks no handle.
 *
 * `fromByte` is inclusive, `toByte` exclusive; both are absolute offsets.
 */
export async function* readFileChunks(
  filePath: string,
  opts: { fromByte?: number; toByte?: number; chunkBytes?: number } = {},
): AsyncGenerator<Uint8Array> {
  const chunkBytes = opts.chunkBytes ?? 512 * 1024;
  let position = Math.max(0, opts.fromByte ?? 0);
  const end = opts.toByte ?? Infinity;
  const handle = await open(filePath, "r");
  try {
    while (position < end) {
      const want = Math.min(chunkBytes, end - position);
      const buf = new Uint8Array(want);
      const { bytesRead } = await handle.read(buf, 0, want, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield bytesRead === want ? buf : buf.subarray(0, bytesRead);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
