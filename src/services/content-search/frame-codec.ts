/**
 * The search host's stdin/stdout protocol: `[u8 kind][u32 id][u32 length][payload]`,
 * integers big-endian.
 *
 * `FrameDecoder` runs on the server's main thread, so it never copies a payload:
 * a frame's `parts` are `subarray`s of the chunks it was pushed, ready for
 * `new Blob(parts)`. Only a header split across chunks is copied (9 bytes).
 * A caller must therefore not reuse a chunk's memory after pushing it.
 */

export const FRAME_KINDS = {
  ready: 1,
  search: 2,
  replace: 3,
  cancel: 4,
  reply: 5,
  "reply-error": 6,
} as const;

export type FrameKind = keyof typeof FRAME_KINDS;

export const FRAME_HEADER_BYTES = 9;

export interface Frame {
  kind: FrameKind;
  id: number;
  parts: Uint8Array[];
}

const KIND_BY_CODE = new Map<number, FrameKind>(
  (Object.entries(FRAME_KINDS) as Array<[FrameKind, number]>).map(([k, c]) => [c, k]),
);

const U32_MAX = 0xffff_ffff;

export function encodeFrame(kind: FrameKind, id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const code = FRAME_KINDS[kind];
  if (code === undefined) throw new Error(`Unknown frame kind: ${String(kind)}`);
  if (!Number.isInteger(id) || id < 0 || id > U32_MAX) throw new RangeError(`Frame id out of range: ${id}`);
  if (payload.byteLength > U32_MAX) throw new RangeError(`Frame payload too large: ${payload.byteLength}`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, code);
  view.setUint32(1, id);
  view.setUint32(5, payload.byteLength);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export class FrameDecoder {
  private readonly header = new Uint8Array(FRAME_HEADER_BYTES);
  private headerFill = 0;
  /** Set once the header is complete: the frame being filled. */
  private current: { kind: FrameKind; id: number; remaining: number; parts: Uint8Array[] } | null = null;

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let off = 0;
    const end = chunk.byteLength;
    while (true) {
      if (!this.current) {
        if (off >= end) break;
        const take = Math.min(FRAME_HEADER_BYTES - this.headerFill, end - off);
        this.header.set(chunk.subarray(off, off + take), this.headerFill);
        this.headerFill += take;
        off += take;
        if (this.headerFill < FRAME_HEADER_BYTES) break;
        this.headerFill = 0;
        const view = new DataView(this.header.buffer);
        const code = view.getUint8(0);
        const kind = KIND_BY_CODE.get(code);
        if (!kind) throw new Error(`Corrupt frame stream: unknown kind ${code}`);
        this.current = { kind, id: view.getUint32(1), remaining: view.getUint32(5), parts: [] };
      }
      const cur = this.current;
      const take = Math.min(cur.remaining, end - off);
      if (take > 0) {
        cur.parts.push(chunk.subarray(off, off + take));
        cur.remaining -= take;
        off += take;
      }
      if (cur.remaining > 0) break;
      frames.push({ kind: cur.kind, id: cur.id, parts: cur.parts });
      this.current = null;
    }
    return frames;
  }
}
