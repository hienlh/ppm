/**
 * Export to ZIP file: every file of a run in one zip, each under the name its row gave it. DBGate
 * has it in its Pro edition only, and names the zip itself; here the name is the user's.
 */
import { createReadStream, type ReadStream } from "node:fs";
import archiver from "archiver";
import { entryDone } from "../grid-export-xlsx.ts";

export interface ZipEntry {
  /** Where the server keeps the file. */
  path: string;
  /** What the zip calls it. */
  name: string;
}

/**
 * The zip, a piece at a time, each file read as it is compressed — none is held whole. The files go
 * in one at a time, each through a stream of our own: archiver's `file()` opens one that its
 * `abort()` never closes, so a zip not read to its end (Stop) kept that file open — and on Linux its
 * disk space taken — for as long as PPM ran.
 */
export async function* zipFiles(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
  // A zip's times carry no zone and every unzip reads them as local time; archiver writes UTC
  // unless told otherwise, which dated each extracted file hours off anywhere but UTC.
  const archive = archiver("zip", { zlib: { level: 5 }, forceLocalTime: true });
  let reading: ReadStream | null = null;
  const feed = async (): Promise<void> => {
    for (const e of entries) {
      const file = createReadStream(e.path);
      reading = file;
      // archiver pipes the stream through a PassThrough of its own, which an error does not cross:
      // a file that is gone has to fail the zip, not be left out of it.
      const failed = new Promise<never>((_, reject) => file.once("error", reject));
      failed.catch(() => {});
      const done = entryDone(archive);
      archive.append(file, { name: e.name });
      await Promise.race([done, failed]);
    }
    reading = null;
    await archive.finalize();
  };
  const fed = feed().catch((e: unknown) => {
    // Ends the reading below with the error, which then reaches whoever reads the zip.
    archive.destroy(e as Error);
    throw e;
  });
  fed.catch(() => {});
  try {
    for await (const chunk of archive as AsyncIterable<Buffer>) yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    await fed;
  } finally {
    archive.abort();
    (reading as ReadStream | null)?.destroy();
  }
}
