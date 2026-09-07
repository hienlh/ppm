/**
 * Incremental Annex-B start-code splitter.
 *
 * ffmpeg's `-f h264` stdout is a raw Annex-B byte stream: NAL units separated by
 * `00 00 01` or `00 00 00 01` start codes, with no framing that respects our read
 * chunk boundaries. A NAL can straddle two `stdout` reads, so this holds the tail
 * of the last incomplete NAL across calls to `push()` rather than assuming a full
 * NAL always arrives in one chunk.
 */

/** NAL unit types relevant to access-unit assembly (ITU-T H.264 Table 7-1). */
export const NAL_TYPE_SLICE_NON_IDR = 1;
export const NAL_TYPE_IDR = 5;
export const NAL_TYPE_SPS = 7;
export const NAL_TYPE_PPS = 8;

/** Low 5 bits of the NAL header byte (the unit's first byte) is `nal_unit_type`. */
export function nalType(nal: Uint8Array): number {
  return (nal[0] ?? 0) & 0x1f;
}

/** A slice NAL starts a new access unit; SPS/PPS/AUD/SEI attach to whichever AU follows them. */
export function isVclNal(nal: Uint8Array): boolean {
  const t = nalType(nal);
  return t === NAL_TYPE_SLICE_NON_IDR || t === NAL_TYPE_IDR;
}

/** `Bun.spawn` stdout chunks type as `Uint8Array<ArrayBufferLike>` (could in principle back
 *  onto a SharedArrayBuffer), while `new Uint8Array(n)` types as the narrower
 *  `Uint8Array<ArrayBuffer>` — pin everything here to the wider type so a plain chunk and our
 *  own freshly-allocated buffers can always mix without a type error. */
export type Bytes = Uint8Array<ArrayBufferLike>;

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index of the next `00 00 01` marker at or after `from`, or -1. This always finds the
 *  *last* 3 bytes of a start code — a 4-byte `00 00 00 01` form has its 3-byte suffix match
 *  here too (at index+1), and H.264 emulation prevention guarantees `00 00 01`/`00 00 00`
 *  never occurs inside real RBSP payload data, so there is no false-positive risk scanning
 *  straight through NAL bodies. */
function findStartCode(buf: Bytes, from: number): number {
  for (let i = from; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
  }
  return -1;
}

/** Bytes to skip past a marker found by `findStartCode` to reach the payload — always 3
 *  (the marker itself), regardless of how many extra leading zero bytes preceded it. */
const MARKER_LEN = 3;

/** Guard against an unbounded buffer if ffmpeg ever emits a byte stream with no start
 *  code at all (would indicate a broken pipe/format, not a real Annex-B stream). */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export class NalSplitter {
  private buffer: Bytes = new Uint8Array(0);

  /** Feed a raw stdout chunk; returns zero or more complete NAL payloads (start code
   *  stripped). Incomplete trailing bytes are retained for the next call. */
  push(chunk: Bytes): Bytes[] {
    this.buffer = concat(this.buffer, chunk);
    const nals: Bytes[] = [];

    let start = findStartCode(this.buffer, 0);
    if (start === -1) {
      if (this.buffer.length > MAX_BUFFER_BYTES) this.buffer = new Uint8Array(0);
      return nals;
    }
    // Drop any garbage before the first start code (should not happen with a clean
    // ffmpeg pipe, but a partial NAL from before this splitter attached must not corrupt
    // the first parsed unit).
    for (;;) {
      const nextStart = findStartCode(this.buffer, start + MARKER_LEN);
      if (nextStart === -1) {
        this.buffer = this.buffer.slice(start);
        break;
      }
      // `nextStart` only marks the *last* 3 bytes of the following start code — a 4-byte
      // `00 00 00 01` form leaves its leading zero sitting right before `nextStart`, which
      // would otherwise get appended to this NAL's payload as a spurious trailing byte.
      // Trim any such zero bytes back to the real payload end (standard Annex-B handling of
      // `leading_zero_8bits`/`trailing_zero_8bits`).
      let payloadEnd = nextStart;
      const payloadStart = start + MARKER_LEN;
      while (payloadEnd > payloadStart && this.buffer[payloadEnd - 1] === 0) payloadEnd--;
      const payload = this.buffer.slice(payloadStart, payloadEnd);
      if (payload.length > 0) nals.push(payload);
      start = nextStart;
    }
    return nals;
  }
}
