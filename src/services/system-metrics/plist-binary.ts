/**
 * Binary property lists (`bplist00`), the other format an app's Info.plist ships
 * in: 3 of the 75 bundles running on an M1 Max, Safari's among them; the other 72
 * were XML. Read in-process, so listing apps needs no `plutil` spawn per bundle,
 * into exactly the values `parsePlistXml` returns — a date is its ISO text.
 *
 * The layout (CFBinaryPList.c): an 8-byte magic, the objects, an offset table and
 * a 32-byte trailer giving the width of an offset and of an object reference, the
 * object count, the root object and where the table starts. Each object opens with
 * a marker byte: its type in the high nibble, a count or width in the low one, and
 * 0xF there meaning an integer object follows with the real count.
 *
 * The file belongs to whatever app is installed, so none of it is trusted. Every
 * offset and count is checked against the buffer; a reference back to an object
 * still being read is a cycle and fails the parse; and each object is read once
 * and then shared, because without that a few hundred bytes of arrays that each
 * name the next one twice unfold into 2^n values.
 */
import { parsePlistXml, type PlistDict, type PlistValue } from "./plist-xml.ts";

const MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]; // "bplist00"
const TRAILER_BYTES = 32;
const WIDTHS = new Set([1, 2, 4, 8]);
/** An Info.plist nests a handful of levels; this only has to stop a hostile file. */
const MAX_DEPTH = 64;
/** Seconds from the Unix epoch to CFAbsoluteTime's, 2001-01-01T00:00:00Z. */
const CF_EPOCH_SECONDS = 978_307_200;

export function isBinaryPlist(bytes: Uint8Array): boolean {
  return bytes.byteLength >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);
}

/** A plist file in either format: binary by its magic, XML otherwise. */
export function parsePlistBytes(bytes: Uint8Array): PlistValue | undefined {
  return isBinaryPlist(bytes) ? parsePlistBinary(bytes) : parsePlistXml(new TextDecoder().decode(bytes));
}

/** The document's root value, or undefined for anything that is not a well-formed binary plist. */
export function parsePlistBinary(bytes: Uint8Array): PlistValue | undefined {
  if (bytes.byteLength < MAGIC.length + TRAILER_BYTES || !isBinaryPlist(bytes)) return undefined;
  try {
    return new Reader(bytes).root();
  } catch {
    // A bounds check this file does not make is a RangeError from the DataView:
    // still an unreadable plist, never an exception out of a tick.
    return undefined;
  }
}

/** Parsing failed: the file is not a plist this reader will vouch for. */
class Malformed extends Error {}

/** A valid object with no plist value of its own (null, fill); skipped where it appears. */
const NOTHING = Symbol("nothing");
type Parsed = PlistValue | typeof NOTHING;

class Reader {
  private readonly view: DataView;
  /** Objects end before the trailer. */
  private readonly limit: number;
  private readonly offsetSize: number;
  private readonly refSize: number;
  private readonly count: number;
  private readonly top: number;
  private readonly tableAt: number;
  private readonly done = new Map<number, Parsed>();
  private readonly reading = new Set<number>();

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const t = bytes.byteLength - TRAILER_BYTES;
    this.limit = t;
    this.offsetSize = bytes[t + 6]!;
    this.refSize = bytes[t + 7]!;
    this.count = this.uint(t + 8, 8);
    this.top = this.uint(t + 16, 8);
    this.tableAt = this.uint(t + 24, 8);
    if (!WIDTHS.has(this.offsetSize) || !WIDTHS.has(this.refSize)) throw new Malformed();
    if (this.count < 1 || this.top >= this.count) throw new Malformed();
    if (this.tableAt < MAGIC.length || this.tableAt + this.count * this.offsetSize > t) throw new Malformed();
  }

  root(): PlistValue | undefined {
    const value = this.object(this.top, 0);
    return value === NOTHING ? undefined : value;
  }

  private object(index: number, depth: number): Parsed {
    if (index >= this.count || depth > MAX_DEPTH) throw new Malformed();
    const cached = this.done.get(index);
    if (cached !== undefined) return cached;
    if (this.reading.has(index)) throw new Malformed(); // a cycle
    this.reading.add(index);
    const value = this.read(this.uint(this.tableAt + index * this.offsetSize, this.offsetSize), depth);
    this.reading.delete(index);
    this.done.set(index, value);
    return value;
  }

  private read(at: number, depth: number): Parsed {
    if (at < MAGIC.length || at >= this.limit) throw new Malformed();
    const marker = this.bytes[at]!;
    const info = marker & 0x0f;
    switch (marker >> 4) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        if (marker === 0x00 || marker === 0x0f) return NOTHING;
        throw new Malformed();
      case 0x1: // 2^info bytes, big-endian
        return this.int(at + 1, info);
      case 0x2: // float32 or float64
        if (info === 2) return this.finite(this.float(at + 1, 4));
        if (info === 3) return this.finite(this.float(at + 1, 8));
        throw new Malformed();
      case 0x3: // CFAbsoluteTime as float64
        if (marker !== 0x33) throw new Malformed();
        return isoDate(this.finite(this.float(at + 1, 8)));
      case 0x4: { // data
        const { n, start } = this.length(at, info);
        return this.bytes.slice(start, this.end(start, n));
      }
      case 0x5: { // ASCII
        const { n, start } = this.length(at, info);
        return this.buffer(start, this.end(start, n)).toString("latin1");
      }
      case 0x6: { // UTF-16BE code units
        const { n, start } = this.length(at, info);
        // Copied, so swapping to little-endian leaves the caller's bytes alone.
        return Buffer.from(this.buffer(start, this.end(start, n * 2))).swap16().toString("utf16le");
      }
      case 0x8: // UID, info + 1 bytes
        this.end(at + 1, info + 1);
        return this.uint(at + 1, info + 1);
      case 0xa: // array
      case 0xc: { // set, as an array
        const { n, start } = this.length(at, info);
        this.end(start, n * this.refSize);
        const out: PlistValue[] = [];
        for (let i = 0; i < n; i++) {
          const v = this.object(this.uint(start + i * this.refSize, this.refSize), depth + 1);
          if (v !== NOTHING) out.push(v);
        }
        return out;
      }
      case 0xd: { // n key references, then n value references
        const { n, start } = this.length(at, info);
        this.end(start, n * 2 * this.refSize);
        const dict: PlistDict = Object.create(null);
        for (let i = 0; i < n; i++) {
          const key = this.object(this.uint(start + i * this.refSize, this.refSize), depth + 1);
          if (typeof key !== "string") throw new Malformed();
          const v = this.object(this.uint(start + (n + i) * this.refSize, this.refSize), depth + 1);
          if (v !== NOTHING) dict[key] = v;
        }
        return dict;
      }
      default:
        throw new Malformed();
    }
  }

  /** A count in the marker, or in the integer object after it when the marker says 0xF. */
  private length(at: number, info: number): { n: number; start: number } {
    if (info !== 0x0f) return { n: info, start: at + 1 };
    const intMarker = this.bytes[at + 1];
    if (intMarker === undefined || intMarker >> 4 !== 0x1) throw new Malformed();
    const width = 1 << (intMarker & 0x0f);
    const n = this.int(at + 2, intMarker & 0x0f);
    if (!Number.isSafeInteger(n) || n < 0) throw new Malformed();
    return { n, start: at + 2 + width };
  }

  /** 1, 2 and 4 bytes are unsigned and 8 signed, as CoreFoundation writes them; 16
   *  bytes carry an unsigned 64-bit value in their low half. */
  private int(at: number, info: number): number {
    if (info <= 2) return this.uint(at, 1 << info);
    if (info === 3) {
      this.span(at, 8);
      return Number(this.view.getBigInt64(at));
    }
    if (info === 4) {
      this.span(at, 16);
      return Number(this.view.getBigUint64(at + 8));
    }
    throw new Malformed();
  }

  private float(at: number, width: 4 | 8): number {
    this.span(at, width);
    return width === 4 ? this.view.getFloat32(at) : this.view.getFloat64(at);
  }

  /** A view of the file's bytes, not a copy. */
  private buffer(start: number, end: number): Buffer {
    return Buffer.from(this.bytes.buffer, this.bytes.byteOffset + start, end - start);
  }

  private uint(at: number, width: number): number {
    this.span(at, width);
    switch (width) {
      case 1: return this.view.getUint8(at);
      case 2: return this.view.getUint16(at);
      case 4: return this.view.getUint32(at);
      case 8: return Number(this.view.getBigUint64(at));
      default: {
        // A UID can be 3 bytes wide.
        let n = 0;
        for (let i = 0; i < width; i++) n = n * 256 + this.bytes[at + i]!;
        return n;
      }
    }
  }

  /** Throws unless `width` bytes from `at` lie inside the file. */
  private span(at: number, width: number): void {
    if (at < 0 || width < 0 || at + width > this.bytes.byteLength) throw new Malformed();
  }

  /** The end of `n` bytes from `start`, which must not run into the trailer. */
  private end(start: number, n: number): number {
    if (!Number.isSafeInteger(n) || n < 0 || start + n > this.limit) throw new Malformed();
    return start + n;
  }

  private finite(n: number): number {
    if (!Number.isFinite(n)) throw new Malformed();
    return n;
  }
}

/** The form plutil writes in XML: `2026-09-30T12:00:00Z`, milliseconds only when present. */
function isoDate(cfSeconds: number): string {
  const iso = new Date((cfSeconds + CF_EPOCH_SECONDS) * 1000).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}
