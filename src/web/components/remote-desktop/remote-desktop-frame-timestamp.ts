/**
 * Strictly-increasing microsecond timestamps for `EncodedVideoChunk`.
 *
 * The decoder previously used `performance.now() * 1000` per chunk. Some decoders — especially
 * mobile hardware H.264 decoders — reject a chunk whose timestamp does not strictly increase
 * from the previous one; two chunks landing in the same millisecond (easy at 30fps under normal
 * network/encode jitter) get equal timestamps and can trip that check.
 *
 * This is decode-only playback (no A/V sync, nothing ever reads the timestamp back to schedule
 * presentation), so the value only has to satisfy "strictly greater than the last one" — a
 * frame-index-based synthetic clock does that unconditionally, independent of wall-clock
 * resolution or jitter.
 */
const DEFAULT_FPS = 30;

/** `frameIndex` is a 0-based, ever-incrementing counter of chunks decoded by ONE decoder
 *  instance — reset it to 0 whenever a new `VideoDecoder` is created (a fresh instance has no
 *  timestamp history to stay monotonic against). */
export function frameTimestampMicros(frameIndex: number, fps: number = DEFAULT_FPS): number {
  return Math.round((frameIndex * 1_000_000) / fps);
}
