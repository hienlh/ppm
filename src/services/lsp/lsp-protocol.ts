/**
 * The wire format language servers speak over stdio.
 *
 * Each message is an HTTP-style header block terminated by a blank line,
 * followed by exactly `Content-Length` bytes of JSON:
 *
 *     Content-Length: 42\r\n
 *     \r\n
 *     {"jsonrpc":"2.0","id":1,"result":null}
 *
 * The framing is decoded over **bytes**, never over a decoded string, because
 * `Content-Length` counts bytes. A single multi-byte character anywhere in the
 * payload — a curly quote in a hover, a Vietnamese identifier, an emoji in a
 * doc comment — makes the character count smaller than the byte count, so a
 * string-based decoder cuts the body short, fails to parse, and then reads the
 * next message's header as body. The stream never recovers, and it only happens
 * for some files, which is the worst possible failure to debug.
 *
 * A chunk from a pipe has no relationship to a message boundary: it can carry
 * half a header, one message, or six and a half. The decoder therefore buffers
 * and yields only whole messages.
 */

const CRLFCRLF = new Uint8Array([13, 10, 13, 10]); // \r\n\r\n

/**
 * Refuse a message larger than this. A server should never send one; a bogus or
 * corrupted `Content-Length` otherwise makes the decoder wait forever while the
 * buffer grows without bound.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Give up looking for the end of a header block after this many bytes.
 *
 * A real header block is under a hundred bytes. Without a bound, a server that
 * writes something other than framing to stdout — a panic trace, a wrapper
 * script's warning, a node deprecation notice — has no separator to find, so
 * the decoder buffers it forever and the session stays "ready" while serving
 * nothing. That is the worst outcome available: no error, no output, no clue.
 *
 * The bound cannot be tight enough to catch *small* stray output, because an
 * unknown header is legal and `panic: runtime error` is indistinguishable from
 * one until the separator turns up. A few lines of stray text therefore still
 * stalls the stream — but request timeouts fire and are reported, so it
 * surfaces as a named failure rather than a hang.
 */
export const MAX_HEADER_BYTES = 4096;

/** Everything that can appear on the wire, as far as the framing cares. */
export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function encodeMessage(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  // Latin-1 is enough for the header: it is all ASCII by construction.
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** Index of `needle` in `haystack` at or after `from`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Accumulates bytes from a server's stdout and yields whole messages.
 *
 * One decoder belongs to one stream; it holds the partial tail between chunks.
 */
export class LspMessageDecoder {
  private buffer = new Uint8Array(0);
  /** Byte length the current header block promised, or -1 when between messages. */
  private expected = -1;
  /** Offset in `buffer` where the current message's body starts. */
  private bodyStart = 0;

  /**
   * Feed one chunk. Returns every message that became complete.
   *
   * Throws on a header block that is not valid framing — a server writing plain
   * text to stdout (a crash trace, a deprecation notice) desynchronises the
   * stream, and there is no honest way to resynchronise, so the caller has to
   * restart the server rather than silently drop input.
   */
  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.append(chunk);
    const messages: JsonRpcMessage[] = [];

    for (;;) {
      if (this.expected < 0) {
        const separator = indexOfBytes(this.buffer, CRLFCRLF, 0);
        if (separator < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            throw new Error(
              `No LSP header found in the first ${MAX_HEADER_BYTES} bytes of output; ` +
              `the server is not speaking the protocol: ` +
              `${JSON.stringify(new TextDecoder("latin1").decode(this.buffer.subarray(0, 200)))}`,
            );
          }
          return messages; // header block still incomplete
        }
        const header = new TextDecoder("latin1").decode(this.buffer.subarray(0, separator));
        this.expected = parseContentLength(header);
        this.bodyStart = separator + CRLFCRLF.length;
      }

      if (this.buffer.length - this.bodyStart < this.expected) return messages; // body still incomplete

      const body = this.buffer.subarray(this.bodyStart, this.bodyStart + this.expected);
      const text = new TextDecoder().decode(body);
      this.buffer = this.buffer.slice(this.bodyStart + this.expected);
      this.expected = -1;
      this.bodyStart = 0;

      try {
        messages.push(JSON.parse(text) as JsonRpcMessage);
      } catch {
        // The framing was right, so the stream is still aligned — this one
        // message is unreadable. Dropping it loses one response; throwing would
        // take down a session that is otherwise fine.
        continue;
      }
    }
  }

  private append(chunk: Uint8Array): void {
    if (this.buffer.length === 0) {
      this.buffer = chunk.slice();
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }
}

function parseContentLength(headerBlock: string): number {
  for (const line of headerBlock.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    // Header names are case-insensitive, and servers do differ in casing.
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid Content-Length in LSP header: "${line}"`);
    }
    if (value > MAX_MESSAGE_BYTES) {
      throw new Error(`LSP message of ${value} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`);
    }
    return value;
  }
  throw new Error(`LSP header block carried no Content-Length: ${JSON.stringify(headerBlock.slice(0, 200))}`);
}
