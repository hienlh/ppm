/**
 * Pixel dimensions read from an image file header.
 *
 * Only the header is needed, so callers can decode a few kilobytes instead of a whole
 * image. Returns null for formats or truncated buffers it cannot read; callers must treat
 * that as "unknown" rather than assuming a size.
 */
export interface PixelSize {
  w: number;
  h: number;
}

export function readImageDimensions(head: Buffer): PixelSize | null {
  return png(head) ?? gif(head) ?? webp(head) ?? jpeg(head);
}

function png(b: Buffer): PixelSize | null {
  // \x89PNG, then an IHDR chunk whose width/height are big-endian uint32.
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function gif(b: Buffer): PixelSize | null {
  if (b.length < 10 || b.subarray(0, 3).toString("latin1") !== "GIF") return null;
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
}

function webp(b: Buffer): PixelSize | null {
  if (b.length < 30) return null;
  if (b.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (b.subarray(8, 12).toString("latin1") !== "WEBP") return null;

  const chunk = b.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X") {
    // Canvas size is stored minus one, as two 24-bit little-endian values.
    return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  }
  if (chunk === "VP8 ") {
    // 14-bit width and height follow the 3-byte start code and 0x9d012a signature.
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function jpeg(b: Buffer): PixelSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  // A frame header's last byte sits at offset+8, so offset+9 may equal the length.
  while (offset + 9 <= b.length) {
    if (b[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = b[offset + 1]!;
    // Start-of-frame markers carry the dimensions; skip DHT/DAC/DNL which share the range.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { h: b.readUInt16BE(offset + 5), w: b.readUInt16BE(offset + 7) };
    const length = b.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
