/**
 * An uploaded file as text, a piece at a time, never read whole: UTF-8 with or without its byte
 * order mark, or UTF-16 with one — what PPM's "CSV for Excel" writes. Bytes that are not text in
 * that encoding fail the read: turned into "�" they would be imported as a different value.
 */

/** The encoding the first bytes name, and how many of them the mark takes. */
function encodingOf(head: Uint8Array): { encoding: "utf-8" | "utf-16le" | "utf-16be"; skip: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: "utf-8", skip: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: "utf-16le", skip: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: "utf-16be", skip: 2 };
  return { encoding: "utf-8", skip: 0 };
}

export class FileTextError extends Error {}

/**
 * Work between two pauses for the event loop. A file is read without waiting on the disk, so
 * reading it — with whatever is done with one piece before the next is asked for, such as a
 * SQLite write — is otherwise one turn of the event loop: a million rows imported into SQLite
 * held every other request for 0.8 s.
 */
const SLICE_MS = 16;

function notText(encoding: string): FileTextError {
  return encoding === "utf-8"
    ? new FileTextError("The file is not UTF-8 text: save it as UTF-8, or as UTF-16 with a byte order mark, and add it again")
    : new FileTextError(`The file is not ${encoding.toUpperCase()} text, though its byte order mark says it is`);
}

/** The text of the file at `path`, in pieces as it is read. Stop ends it between two pieces. */
export async function* fileText(path: string, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  let decoder: TextDecoder | null = null;
  let encoding = "utf-8";
  let head: Uint8Array = new Uint8Array(0);
  const decode = (bytes?: Uint8Array): string => {
    try {
      return bytes ? decoder!.decode(bytes, { stream: true }) : decoder!.decode();
    } catch {
      throw notText(encoding);
    }
  };
  const start = (bytes: Uint8Array): Uint8Array => {
    const found = encodingOf(bytes);
    encoding = found.encoding;
    decoder = new TextDecoder(found.encoding, { fatal: true, ignoreBOM: true });
    return bytes.subarray(found.skip);
  };
  let sliceStart = performance.now();
  try {
    for (;;) {
      if (performance.now() - sliceStart >= SLICE_MS) {
        await new Promise((r) => setTimeout(r, 0));
        sliceStart = performance.now();
      }
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      let bytes: Uint8Array = value;
      if (!decoder) {
        // A mark is up to three bytes, which the first piece may not hold.
        head = head.length ? Buffer.concat([head, bytes]) : bytes;
        if (head.length < 3) continue;
        bytes = start(head);
      }
      const text = decode(bytes);
      if (text) yield text;
    }
    if (!decoder) {
      const text = decode(start(head));
      if (text) yield text;
    }
    const rest = decode();
    if (rest) yield rest;
  } finally {
    // Read to its end or not, the file is closed.
    await reader.cancel().catch(() => {});
  }
}
