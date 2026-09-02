/** Pure buffer parser for the Apple Bookmark binary record (the `Bookmark`
 *  blob stored per-item in a Finder sidebar `.sfl2`/`.sfl3`/`.sfl4` file).
 *  Format is Apple-undocumented and reverse-engineered — see the mac-alias
 *  bookmark-format writeup this follows: 48-byte header (magic `book`,
 *  total-size, version, header-size-constant, 32 reserved bytes), a 4-byte
 *  TOC offset at byte 48, a TOC of `(key, dataOffset, reserved)` triples, and
 *  self-describing data records (`length` + `type` + payload). All offsets
 *  in this implementation are absolute from the start of the buffer.
 *  UNVERIFIED against a real macOS sample — field constants come from public
 *  reverse-engineering writeups, not Apple docs; re-validate before shipping. */

export class BookmarkDecodeError extends Error {}

const MAGIC = "book";
const TOC_MAGIC = 0xfffffffe;

/** Data record type codes (low 16 bits distinguish the payload shape). */
const TYPE_STRING = 0x0101; // UTF-8 bytes
const TYPE_ARRAY = 0x0201; // payload = concatenated 4-byte LE offsets into other data records

/** TOC key for the path-components array (`kBookmarkPath`). */
const KEY_PATH = 0x1004;
/** TOC keys that may carry a cross-volume prefix (external drives) — try both. */
const KEY_VOLUME_PATH_CANDIDATES = [0x1005, 0x2002];

interface TocEntry {
  key: number;
  dataOffset: number;
}

function readToc(buf: Buffer, tocOffset: number): TocEntry[] {
  if (tocOffset + 20 > buf.length) throw new BookmarkDecodeError("TOC offset out of range");
  const magic = buf.readUInt32LE(tocOffset + 4);
  if (magic !== TOC_MAGIC) throw new BookmarkDecodeError(`bad TOC magic 0x${magic.toString(16)}`);
  const entryCount = buf.readUInt32LE(tocOffset + 16);
  const entries: TocEntry[] = [];
  let cursor = tocOffset + 20;
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 12 > buf.length) throw new BookmarkDecodeError("TOC entry out of range");
    entries.push({ key: buf.readUInt32LE(cursor), dataOffset: buf.readUInt32LE(cursor + 4) });
    cursor += 12;
  }
  return entries;
}

function readDataRecord(buf: Buffer, offset: number): { type: number; payload: Buffer } {
  if (offset + 8 > buf.length) throw new BookmarkDecodeError("data record offset out of range");
  const length = buf.readUInt32LE(offset);
  const type = buf.readUInt32LE(offset + 4);
  const payloadStart = offset + 8;
  const payloadEnd = payloadStart + length;
  if (payloadEnd > buf.length) throw new BookmarkDecodeError("data record payload out of range");
  return { type, payload: buf.subarray(payloadStart, payloadEnd) };
}

function readString(buf: Buffer, offset: number): string {
  const { type, payload } = readDataRecord(buf, offset);
  if (type !== TYPE_STRING) throw new BookmarkDecodeError(`expected string record, got type 0x${type.toString(16)}`);
  return payload.toString("utf-8");
}

function readArrayOfStrings(buf: Buffer, offset: number): string[] {
  const { type, payload } = readDataRecord(buf, offset);
  if (type !== TYPE_ARRAY) throw new BookmarkDecodeError(`expected array record, got type 0x${type.toString(16)}`);
  if (payload.length % 4 !== 0) throw new BookmarkDecodeError("array payload not a multiple of 4 bytes");
  const items: string[] = [];
  for (let i = 0; i < payload.length; i += 4) {
    items.push(readString(buf, payload.readUInt32LE(i)));
  }
  return items;
}

/** Decode an Apple Bookmark record into an absolute POSIX path.
 *  Throws `BookmarkDecodeError` on any structural mismatch — callers must
 *  catch and turn it into a `warnings[]` entry, never let it reach the HTTP layer. */
export function decodeBookmarkPath(buf: Buffer): string {
  if (buf.length < 52 || buf.subarray(0, 4).toString("ascii") !== MAGIC) {
    throw new BookmarkDecodeError("missing 'book' magic header");
  }
  const tocOffset = buf.readUInt32LE(48);
  const toc = readToc(buf, tocOffset);

  const pathEntry = toc.find((e) => e.key === KEY_PATH);
  if (!pathEntry) throw new BookmarkDecodeError("no kBookmarkPath (0x1004) entry in TOC");
  const components = readArrayOfStrings(buf, pathEntry.dataOffset);

  let volumePath = "";
  const volumeEntry = toc.find((e) => KEY_VOLUME_PATH_CANDIDATES.includes(e.key));
  if (volumeEntry) {
    try {
      volumePath = readString(buf, volumeEntry.dataOffset);
    } catch {
      // Volume key present but not a plain string (e.g. a UUID data record) — assume boot volume.
    }
  }
  return `${volumePath}/${components.join("/")}`;
}
