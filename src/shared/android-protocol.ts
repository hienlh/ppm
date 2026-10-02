/**
 * The `/ws/android` wire format, version 1. Shared by `src/server/ws/android.ts` and the
 * browser viewer so neither can drift from the other.
 *
 * Text frames are JSON control messages; binary frames are video. Video never travels as
 * base64 inside JSON — that is a 33% tax on the one thing that has a bandwidth budget.
 *
 * Two generations ride on every message, and they answer different questions:
 *  - `sessionGeneration` changes when control moves to another client (a Take control). It is
 *    what lets the server drop input from a client that has been superseded but does not yet
 *    know it.
 *  - `geometryGeneration` changes when the frame size or rotation changes. Input carrying an
 *    old geometry describes a screen that no longer exists, so it is rejected rather than
 *    mapped onto the new one — the plan's "Reject input theo geometry cũ".
 */

export const ANDROID_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Binary video framing
// ---------------------------------------------------------------------------------------------

/**
 * Header laid out little-endian, then the Annex-B payload:
 *
 *   0  u8   protocol version
 *   1  u8   flags  (bit0 = keyframe, bit1 = codec config)
 *   2  u16  session generation
 *   4  u16  geometry generation
 *   6  u32  sequence number
 *  10  f64  presentation timestamp, milliseconds since the session began
 *  18  u32  payload length
 *  22  ...  payload
 *
 * The length is carried even though a WS frame already delimits itself, because a proxy that
 * coalesces or splits frames would otherwise be undetectable — a truncated access unit decodes
 * to garbage rather than failing.
 */
export const VIDEO_HEADER_BYTES = 22;

export const VIDEO_FLAG_KEYFRAME = 1 << 0;
export const VIDEO_FLAG_CODEC_CONFIG = 1 << 1;

export interface VideoFrameHeader {
  version: number;
  keyframe: boolean;
  codecConfig: boolean;
  sessionGeneration: number;
  geometryGeneration: number;
  sequence: number;
  ptsMs: number;
  payloadLength: number;
}

export function encodeVideoFrame(header: Omit<VideoFrameHeader, "version" | "payloadLength">, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, ANDROID_PROTOCOL_VERSION);
  view.setUint8(1, (header.keyframe ? VIDEO_FLAG_KEYFRAME : 0) | (header.codecConfig ? VIDEO_FLAG_CODEC_CONFIG : 0));
  view.setUint16(2, header.sessionGeneration, true);
  view.setUint16(4, header.geometryGeneration, true);
  view.setUint32(6, header.sequence, true);
  view.setFloat64(10, header.ptsMs, true);
  view.setUint32(18, payload.length, true);
  out.set(payload, VIDEO_HEADER_BYTES);
  return out;
}

/** Returns null when the buffer is too short or the declared length disagrees with what arrived. */
export function decodeVideoFrame(buf: ArrayBuffer | Uint8Array): { header: VideoFrameHeader; payload: Uint8Array } | null {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < VIDEO_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(1);
  const payloadLength = view.getUint32(18, true);
  if (bytes.length - VIDEO_HEADER_BYTES !== payloadLength) return null;
  return {
    header: {
      version: view.getUint8(0),
      keyframe: (flags & VIDEO_FLAG_KEYFRAME) !== 0,
      codecConfig: (flags & VIDEO_FLAG_CODEC_CONFIG) !== 0,
      sessionGeneration: view.getUint16(2, true),
      geometryGeneration: view.getUint16(4, true),
      sequence: view.getUint32(6, true),
      ptsMs: view.getFloat64(10, true),
      payloadLength,
    },
    payload: bytes.subarray(VIDEO_HEADER_BYTES),
  };
}

// ---------------------------------------------------------------------------------------------
// Control messages
// ---------------------------------------------------------------------------------------------

export interface AndroidGeometry {
  /** Frame size actually being encoded. */
  width: number;
  height: number;
  /** The guest's own display size, which the frame may be a scaled copy of. */
  deviceWidth: number;
  deviceHeight: number;
  rotation: 0 | 90 | 180 | 270;
  generation: number;
}

export type AndroidQuality = "low" | "balanced" | "high";

/** Client -> server. */
export type AndroidClientMessage =
  | { type: "auth"; nonce: string; quality?: AndroidQuality; viewport?: { width: number; height: number } }
  | { type: "touch"; geometryGeneration: number; touches: AndroidTouchPoint[] }
  | { type: "key"; geometryGeneration: number; key: string; action: "down" | "up" | "press" }
  /** ASCII only. Anything outside [32,127) is dropped by the emulator *silently* — measured —
   *  so the viewer must route non-ASCII through `paste` instead. */
  | { type: "text"; text: string }
  /** The path for Vietnamese, emoji and CJK: set the guest clipboard, then send the paste combo. */
  | { type: "paste"; text: string }
  | { type: "hardware"; key: "home" | "back" | "recent" | "power" | "volume-up" | "volume-down" }
  | { type: "rotate"; rotation: 0 | 90 | 180 | 270 }
  | { type: "quality"; quality: AndroidQuality }
  | { type: "visibility"; visible: boolean }
  | { type: "input-reset" }
  | { type: "take-control" }
  /** Subscribing starts the device's logcat stream; unsubscribing stops it when nobody is left,
   *  which is the plan's "logs hidden ngừng subscription". */
  | { type: "logcat"; subscribe: boolean }
  | { type: "heartbeat" };

// ---------------------------------------------------------------------------------------------
// Logcat
// ---------------------------------------------------------------------------------------------

export type AndroidLogLevel = "verbose" | "debug" | "info" | "warn" | "error" | "fatal";

export interface AndroidLogEntry {
  /** Monotonic within one device stream, so the viewer can key rows and drop duplicates. */
  id: number;
  /** Unix milliseconds, as the emulator reports them. */
  timestamp: number;
  pid: number;
  tid: number;
  level: AndroidLogLevel;
  tag: string;
  message: string;
}

export interface AndroidTouchPoint {
  /** Frame coordinates, not CSS pixels. The viewer maps before sending. */
  x: number;
  y: number;
  /** Stable for the life of one finger. */
  id: number;
  /** 0 releases the finger. The emulator will not free a slot until it sees one. */
  pressure: number;
}

/** Server -> client. */
export type AndroidServerMessage =
  /** `codec` is the WebCodecs `avc1.PPCCLL` string derived from the real SPS, and is null until
   *  the encoder has emitted its first keyframe — a `codec` message follows when it has.
   *  `encoder` is the ffmpeg encoder's name, for display only. */
  | { type: "ready"; sessionId: string; sessionGeneration: number; geometry: AndroidGeometry; controller: boolean; codec: string | null; encoder: string }
  /** Sent whenever the bitstream's profile/level changes — first keyframe, a rung switch, a
   *  rotation. Never guessed: `encoderArgs` sets no `-profile`/`-level`, so it is encoder-default
   *  and unknown until the bitstream exists, and a wrong string makes `configure()` throw. */
  | { type: "codec"; codec: string }
  | { type: "geometry"; geometry: AndroidGeometry }
  | { type: "controller"; controller: boolean; reason?: string }
  | { type: "quality"; quality: AndroidQuality }
  | { type: "status"; booted: boolean; detail?: string }
  /** A batch of log lines. The first batch after subscribing is the server's ring buffer, so a
   *  panel opened on a device that has been up for an hour is not empty. */
  | { type: "log"; entries: AndroidLogEntry[] }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "heartbeat" };

/** Quality rungs. Height is a **ceiling**: a rung taller than the guest never upscales, which
 *  would spend the whole budget on interpolated pixels. */
export const ANDROID_QUALITY_PRESETS: Record<AndroidQuality, { maxHeight: number; fps: number; bitrate: string }> = {
  low: { maxHeight: 720, fps: 24, bitrate: "1.5M" },
  balanced: { maxHeight: 1280, fps: 30, bitrate: "4M" },
  high: { maxHeight: 1920, fps: 30, bitrate: "8M" },
};
