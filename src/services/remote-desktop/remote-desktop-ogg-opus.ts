/**
 * Pulls Opus packets out of the Ogg stream ffmpeg writes, so the browser gets framed packets it
 * can hand straight to `AudioDecoder` instead of a container it would have to demux itself.
 *
 * Server-side for the same reason `access-unit-assembler.ts` is: the bytes arrive as arbitrary
 * stdout chunks with no relation to packet boundaries, and the code that finds those boundaries
 * is a pure function worth testing once rather than a second implementation in the client.
 *
 * Two things about the Ogg muxer are worth knowing before touching this. It buffers a whole
 * **`page_duration`** before writing a page, and that option defaults to **one second** — the
 * capture spawns with `-page_duration 20000` because the default measured 2000 ms between
 * writes, i.e. two seconds of audio latency on a stream whose video arrives in 20 ms. And a
 * packet may be *split across pages* (the lacing table's 255 means "continues"), which for
 * 96 kbit/s Opus is rare enough to never show up in a short test and certain to show up
 * eventually — a demuxer that ignores continuation emits a truncated packet, which
 * `AudioDecoder` reports as a decode error rather than as a click.
 *
 * Ogg page layout (little-endian): `OggS`, version, header flags, 8-byte granule, 4-byte
 * serial, 4-byte sequence, 4-byte CRC, segment count, then that many lacing bytes, then the
 * payload. The CRC is deliberately **not** verified: this is a pipe from a child process on the
 * same machine, not a network, and the one failure it could catch (a partial write) is already
 * handled by waiting for the full page.
 */

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const HEADER_BYTES = 27;
/** `OpusHead` is 19 bytes; anything shorter is not one. */
const OPUS_HEAD_MIN = 19;

export interface OpusStreamInfo {
  channels: number;
  /** Samples the decoder should discard at the start (Opus encoder warm-up). */
  preSkip: number;
  /** The rate the *source* was at. Opus always decodes at 48 kHz regardless. */
  inputSampleRate: number;
}

/** Parse an `OpusHead` identification header, or null when these bytes are not one. */
export function parseOpusHead(bytes: Uint8Array): OpusStreamInfo | null {
  if (bytes.length < OPUS_HEAD_MIN) return null;
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== "OpusHead") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    channels: bytes[9]!,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
  };
}

/** Feed stdout chunks, get whole Opus audio packets. The two header packets (`OpusHead`,
 *  `OpusTags`) are consumed rather than emitted — the first becomes `info`. */
export class OggOpusDemuxer {
  private buffer = new Uint8Array(0);
  /** Bytes of a packet that ran past the end of its page, awaiting the continuation. */
  private partial: Uint8Array[] = [];
  private streamInfo: OpusStreamInfo | null = null;
  private sawTags = false;

  get info(): OpusStreamInfo | null {
    return this.streamInfo;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat([this.buffer, chunk]);
    const out: Uint8Array[] = [];
    let offset = 0;

    for (;;) {
      const start = findMagic(this.buffer, offset);
      if (start < 0) break;
      if (this.buffer.length < start + HEADER_BYTES) break;
      const segmentCount = this.buffer[start + HEADER_BYTES - 1]!;
      const tableEnd = start + HEADER_BYTES + segmentCount;
      if (this.buffer.length < tableEnd) break;
      const table = this.buffer.subarray(start + HEADER_BYTES, tableEnd);
      let payloadLength = 0;
      for (const n of table) payloadLength += n;
      const pageEnd = tableEnd + payloadLength;
      if (this.buffer.length < pageEnd) break; // page still arriving

      // A page whose first packet continues one from the previous page: `partial` already holds
      // its head. Dropping `partial` on a page that is *not* a continuation is deliberate — it
      // means bytes were lost, and half a packet decodes to noise.
      const continued = (this.buffer[start + 5]! & 0x01) !== 0;
      if (!continued) this.partial = [];

      let cursor = tableEnd;
      let pending: Uint8Array[] = this.partial;
      for (const size of table) {
        pending.push(this.buffer.subarray(cursor, cursor + size));
        cursor += size;
        if (size === 255) continue; // packet continues in the next lacing value
        const packet = concat(pending);
        pending = [];
        this.classify(packet, out);
      }
      // Anything still pending ran off the end of this page; 255 as the last lacing value is
      // exactly how Ogg says "continues on the next page".
      this.partial = pending;
      offset = pageEnd;
    }

    this.buffer = offset > 0 ? this.buffer.slice(offset) : this.buffer;
    return out;
  }

  /** Header packets set up the stream; everything else is audio. Recognised by content rather
   *  than by position, because a stream can be re-announced mid-pipe (ffmpeg restarted). */
  private classify(packet: Uint8Array, out: Uint8Array[]): void {
    if (packet.length === 0) return;
    const head = parseOpusHead(packet);
    if (head) { this.streamInfo = head; this.sawTags = false; return; }
    if (!this.sawTags && startsWith(packet, "OpusTags")) { this.sawTags = true; return; }
    out.push(packet);
  }
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.length < ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) if (bytes[i] !== ascii.charCodeAt(i)) return false;
  return true;
}

function findMagic(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 4 <= bytes.length; i++) {
    if (bytes[i] === OGG_MAGIC[0] && bytes[i + 1] === OGG_MAGIC[1]
      && bytes[i + 2] === OGG_MAGIC[2] && bytes[i + 3] === OGG_MAGIC[3]) return i;
  }
  // Keep the last 3 bytes: they may be the start of a magic split across chunks.
  return -1;
}

/** Always copies, even for a single part. The parts are `subarray` views into the receive
 *  buffer, so returning one would hand the session a window onto a buffer this demuxer goes on
 *  to replace — and would pin the whole old chunk alive for the life of one 240-byte packet. */
function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
