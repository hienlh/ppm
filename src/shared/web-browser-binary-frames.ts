/**
 * Binary messages server → viewer: a 12-byte header, then the payload.
 *
 *   byte 0      kind (1 = JPEG picture, 2 = PCM sound)
 *   bytes 1–4   seq (uint32, little endian): the number the viewer acks a picture with
 *   bytes 5–6   picture: CSS width the page was laid out at / sound: sample rate / 10
 *   bytes 7–8   picture: CSS height / sound: channel count
 *   bytes 9–11  reserved, zero
 *
 * Sound is signed 16-bit little-endian PCM, interleaved. Kept as raw PCM rather than Opus
 * because the viewer must play it on plain-HTTP LAN origins, where `AudioDecoder` does not exist.
 */

export const WEB_BROWSER_FRAME_HEADER_BYTES = 12;
export const FRAME_KIND_JPEG = 1;
export const FRAME_KIND_PCM = 2;

export interface PictureFrame {
  kind: typeof FRAME_KIND_JPEG;
  seq: number;
  cssWidth: number;
  cssHeight: number;
  payload: Uint8Array;
}

export interface SoundFrame {
  kind: typeof FRAME_KIND_PCM;
  seq: number;
  sampleRate: number;
  channels: number;
  payload: Uint8Array;
}

function header(kind: number, seq: number, a: number, b: number, payloadBytes: number): { out: Uint8Array; view: DataView } {
  const out = new Uint8Array(WEB_BROWSER_FRAME_HEADER_BYTES + payloadBytes);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, seq >>> 0, true);
  view.setUint16(5, Math.min(0xffff, Math.max(0, a)), true);
  view.setUint16(7, Math.min(0xffff, Math.max(0, b)), true);
  return { out, view };
}

export function encodePictureFrame(seq: number, cssWidth: number, cssHeight: number, jpeg: Uint8Array): Uint8Array {
  const { out } = header(FRAME_KIND_JPEG, seq, cssWidth, cssHeight, jpeg.byteLength);
  out.set(jpeg, WEB_BROWSER_FRAME_HEADER_BYTES);
  return out;
}

export function encodeSoundFrame(seq: number, sampleRate: number, channels: number, pcm: Uint8Array): Uint8Array {
  const { out } = header(FRAME_KIND_PCM, seq, Math.round(sampleRate / 10), channels, pcm.byteLength);
  out.set(pcm, WEB_BROWSER_FRAME_HEADER_BYTES);
  return out;
}

/** A binary message as a frame, or null when it is too short or of an unknown kind. */
export function decodeBinaryFrame(data: ArrayBuffer | Uint8Array): PictureFrame | SoundFrame | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < WEB_BROWSER_FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);
  const seq = view.getUint32(1, true);
  const a = view.getUint16(5, true);
  const b = view.getUint16(7, true);
  const payload = bytes.subarray(WEB_BROWSER_FRAME_HEADER_BYTES);
  if (kind === FRAME_KIND_JPEG) return { kind, seq, cssWidth: a, cssHeight: b, payload };
  if (kind === FRAME_KIND_PCM) return { kind, seq, sampleRate: a * 10, channels: b, payload };
  return null;
}
