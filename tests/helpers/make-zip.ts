import { deflateRawSync } from "node:zlib";

/**
 * A zip of `files`, every entry deflated, written by hand so a test controls what an archiver
 * would not let it: `lieSize` declares an entry smaller than it inflates to (a zip bomb).
 */
export function makeZip(files: Record<string, string | Uint8Array>, lieSize: Record<string, number> = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const packed = deflateRawSync(data);
    const nameBytes = enc.encode(name);
    const crc = Bun.hash.crc32(data);
    const size = lieSize[name] ?? data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    const localBytes = concat([new Uint8Array(local.buffer), nameBytes, packed]);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x800, true);
    central.setUint16(10, 8, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, packed.length, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(concat([new Uint8Array(central.buffer), nameBytes]));

    locals.push(localBytes);
    offset += localBytes.length;
  }
  const cd = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, centrals.length, true);
  end.setUint16(10, centrals.length, true);
  end.setUint32(12, cd.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, cd, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
