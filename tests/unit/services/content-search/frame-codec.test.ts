import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_KINDS,
  FrameDecoder,
  type Frame,
  type FrameKind,
} from "../../../../src/services/content-search/frame-codec";
import {
  MAX_MATCHES,
  PREVIEW_AFTER,
  PREVIEW_BEFORE,
  TIME_LIMIT_MS,
} from "../../../../src/services/content-search/search-options";

const enc = new TextEncoder();
const dec = new TextDecoder();

function joined(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  return joined(chunks);
}

describe("limits", () => {
  test("match the design", () => {
    expect(MAX_MATCHES).toBe(20_000);
    expect(TIME_LIMIT_MS).toBe(30_000);
    expect(PREVIEW_BEFORE).toBe(26);
    expect(PREVIEW_AFTER).toBe(250);
  });
});

describe("encodeFrame", () => {
  test("writes [u8 kind][u32 id][u32 length][payload], big-endian", () => {
    const payload = enc.encode('{"q":"x"}');
    const frame = encodeFrame("search", 0x01020304, payload);
    expect(FRAME_HEADER_BYTES).toBe(9);
    expect(frame.byteLength).toBe(9 + payload.byteLength);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint8(0)).toBe(FRAME_KINDS.search);
    expect(view.getUint32(1)).toBe(0x01020304);
    expect(view.getUint32(5)).toBe(payload.byteLength);
    expect(dec.decode(frame.subarray(9))).toBe('{"q":"x"}');
  });

  test("an omitted payload is an empty one", () => {
    const frame = encodeFrame("ready", 0);
    expect(frame.byteLength).toBe(9);
    expect(new DataView(frame.buffer, frame.byteOffset).getUint32(5)).toBe(0);
  });

  test("every kind has its own code", () => {
    const codes = Object.values(FRAME_KINDS);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(FRAME_KINDS).sort()).toEqual(
      ["cancel", "ready", "replace", "reply", "reply-error", "search"],
    );
  });

  test("refuses an id that does not fit a u32", () => {
    expect(() => encodeFrame("cancel", -1)).toThrow();
    expect(() => encodeFrame("cancel", 2 ** 32)).toThrow();
    expect(() => encodeFrame("cancel", 1.5)).toThrow();
  });

  test("refuses an unknown kind", () => {
    expect(() => encodeFrame("nope" as FrameKind, 1)).toThrow();
  });
});

describe("FrameDecoder", () => {
  test("decodes one whole frame", () => {
    const d = new FrameDecoder();
    const frames = d.push(encodeFrame("reply", 7, enc.encode("hello")));
    expect(frames).toHaveLength(1);
    expect(frames[0].kind).toBe("reply");
    expect(frames[0].id).toBe(7);
    expect(dec.decode(joined(frames[0].parts))).toBe("hello");
  });

  test("decodes every kind back to its name", () => {
    const d = new FrameDecoder();
    const kinds = Object.keys(FRAME_KINDS) as FrameKind[];
    const frames = d.push(concat(...kinds.map((k, i) => encodeFrame(k, i))));
    expect(frames.map((f) => f.kind)).toEqual(kinds);
    expect(frames.map((f) => f.id)).toEqual(kinds.map((_, i) => i));
  });

  test("decodes several frames packed in one chunk, in order", () => {
    const d = new FrameDecoder();
    const chunk = concat(
      encodeFrame("search", 1, enc.encode("a")),
      encodeFrame("cancel", 2),
      encodeFrame("replace", 3, enc.encode("ccc")),
    );
    const frames = d.push(chunk);
    expect(frames.map((f) => [f.kind, f.id, dec.decode(joined(f.parts))])).toEqual([
      ["search", 1, "a"],
      ["cancel", 2, ""],
      ["replace", 3, "ccc"],
    ]);
  });

  test("an empty payload has no parts", () => {
    const frames = new FrameDecoder().push(encodeFrame("ready", 0));
    expect(frames).toHaveLength(1);
    expect(frames[0].parts).toEqual([]);
  });

  test("an empty chunk yields nothing and breaks nothing", () => {
    const d = new FrameDecoder();
    expect(d.push(new Uint8Array(0))).toEqual([]);
    const frames = d.push(encodeFrame("reply", 9, enc.encode("ok")));
    expect(frames).toHaveLength(1);
    expect(dec.decode(joined(frames[0].parts))).toBe("ok");
  });

  test("reassembles frames fed one byte at a time, header included", () => {
    const d = new FrameDecoder();
    const stream = concat(
      encodeFrame("reply", 0xfffffffe, enc.encode("first é 😀")),
      encodeFrame("reply-error", 4, enc.encode("second")),
    );
    const got: Frame[] = [];
    for (let i = 0; i < stream.byteLength; i++) {
      got.push(...d.push(stream.slice(i, i + 1)));
    }
    expect(got.map((f) => [f.kind, f.id, dec.decode(joined(f.parts))])).toEqual([
      ["reply", 0xfffffffe, "first é 😀"],
      ["reply-error", 4, "second"],
    ]);
  });

  test("a frame ending mid-chunk leaves the rest for the next frame", () => {
    const d = new FrameDecoder();
    const a = encodeFrame("reply", 1, enc.encode("aaaa"));
    const b = encodeFrame("reply", 2, enc.encode("bbbbbb"));
    const stream = concat(a, b);
    const cut = a.byteLength + 4; // inside b's header
    const first = d.push(stream.slice(0, cut));
    expect(first.map((f) => f.id)).toEqual([1]);
    expect(dec.decode(joined(first[0].parts))).toBe("aaaa");
    const second = d.push(stream.slice(cut));
    expect(second.map((f) => f.id)).toEqual([2]);
    expect(dec.decode(joined(second[0].parts))).toBe("bbbbbb");
  });

  test("payload parts are views into the pushed chunks, not copies", () => {
    const d = new FrameDecoder();
    const payload = enc.encode("0123456789abcdefghij");
    const frame = encodeFrame("reply", 5, payload);
    // header + 3 bytes | 10 bytes | the rest
    const c1 = frame.slice(0, 12);
    const c2 = frame.slice(12, 22);
    const c3 = frame.slice(22);
    expect(d.push(c1)).toEqual([]);
    expect(d.push(c2)).toEqual([]);
    const frames = d.push(c3);
    expect(frames).toHaveLength(1);
    const parts = frames[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0].buffer).toBe(c1.buffer);
    expect(parts[0].byteOffset).toBe(c1.byteOffset + 9);
    expect(parts[1].buffer).toBe(c2.buffer);
    expect(parts[2].buffer).toBe(c3.buffer);
    expect(dec.decode(joined(parts))).toBe("0123456789abcdefghij");
    // A view, so writing the chunk shows through the part.
    c2[0] = "X".charCodeAt(0);
    expect(String.fromCharCode(parts[1][0])).toBe("X");
  });

  test("a frame wholly inside one chunk is a single view of that chunk", () => {
    const d = new FrameDecoder();
    const chunk = concat(encodeFrame("cancel", 1), encodeFrame("reply", 2, enc.encode("payload")));
    const frames = d.push(chunk);
    const parts = frames[1].parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].buffer).toBe(chunk.buffer);
    expect(parts[0].byteOffset).toBe(chunk.byteOffset + 9 + 9);
    expect(parts[0].byteLength).toBe(7);
  });

  test("a large payload over many chunks arrives whole", () => {
    const d = new FrameDecoder();
    const payload = new Uint8Array(1_000_003);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const stream = encodeFrame("reply", 3, payload);
    const got: Frame[] = [];
    for (let off = 0; off < stream.byteLength; off += 65_536) {
      got.push(...d.push(stream.slice(off, off + 65_536)));
    }
    expect(got).toHaveLength(1);
    const body = joined(got[0].parts);
    expect(body.byteLength).toBe(payload.byteLength);
    expect(Buffer.from(body).equals(Buffer.from(payload))).toBe(true);
  });

  test("an unknown kind byte means the stream is corrupt", () => {
    const bad = encodeFrame("reply", 1, enc.encode("x"));
    const copy = bad.slice();
    copy[0] = 200;
    expect(() => new FrameDecoder().push(copy)).toThrow();
  });
});
