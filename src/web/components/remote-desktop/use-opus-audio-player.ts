/**
 * Plays the host's audio: Opus packets → `AudioDecoder` → scheduled into one `AudioContext`.
 *
 * The sibling of `use-h264-canvas-decoder.ts`, and it needs no new platform support: every
 * browser that has `VideoDecoder` (which the viewer already hard-requires) has `AudioDecoder`.
 *
 * Scheduling is one `AudioBufferSourceNode` per decoded 20 ms frame against a running cursor,
 * rather than an `AudioWorklet` ring buffer. That is 50 nodes a second, which the audio thread
 * does not notice, and it avoids a separate worklet module — the thing a worklet would buy is
 * sample-accurate underrun handling, and this player wants the opposite: on an underrun it
 * should jump back to "now" and carry on, because a remote desktop's audio has to stay in sync
 * with the picture rather than play every sample late.
 *
 * `TARGET_LEAD_MS` is that resync threshold in both directions. Too small and every network
 * hiccup is a gap; too large and the audio lags the video visibly. 120 ms sits above the ~40 ms
 * the host's Ogg pages arrive in with room for one missed page.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How far ahead of the clock the next frame is scheduled. Also the resync window: a cursor
 *  further behind than this has fallen off and is snapped forward. */
const TARGET_LEAD_MS = 120;
/** Beyond this the client is scheduling audio it will not hear for a noticeable time, which
 *  means the host is producing faster than realtime (a resumed suspended sink) — drop to the
 *  target rather than building a queue that can only be heard late. */
const MAX_LEAD_MS = 400;

export type AudioPlayerStatus = "idle" | "playing" | "unsupported";

export interface UseOpusAudioPlayerResult {
  status: AudioPlayerStatus;
  /** Configure for a stream; safe to call again when the host restarts its encoder. */
  configure: (channels: number, sampleRate: number) => Promise<void>;
  /** Feed one Opus packet. Ignored until `configure` has run. */
  decodePacket: (packet: Uint8Array) => void;
  /** Tear the decoder and the context down. */
  reset: () => void;
  /** Tracks for the recorder to mux in, empty while idle. */
  getTracks: () => MediaStreamTrack[];
}

export function useOpusAudioPlayer(): UseOpusAudioPlayerResult {
  const ctxRef = useRef<AudioContext | null>(null);
  const decoderRef = useRef<AudioDecoder | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  /** When the next frame should start, in the context's own clock. */
  const cursorRef = useRef(0);
  const timestampRef = useRef(0);
  const [status, setStatus] = useState<AudioPlayerStatus>("idle");

  const reset = useCallback(() => {
    try { decoderRef.current?.close(); } catch { /* already closed */ }
    decoderRef.current = null;
    destRef.current = null;
    // The context is closed too, not just disconnected: a suspended AudioContext still holds
    // an audio device open, which on some hosts keeps the sink awake for the whole session.
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => {});
    cursorRef.current = 0;
    timestampRef.current = 0;
    setStatus((s) => (s === "unsupported" ? s : "idle"));
  }, []);

  const play = useCallback((data: AudioData) => {
    const ctx = ctxRef.current;
    if (!ctx) { data.close(); return; }
    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;
    const buffer = ctx.createBuffer(channels, frames, data.sampleRate);
    // `copyTo` per plane: the decoder hands back planar f32, which is exactly what an
    // AudioBuffer channel wants, so there is no interleaving to undo.
    for (let ch = 0; ch < channels; ch++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
      buffer.copyToChannel(plane, ch);
    }
    data.close();

    const now = ctx.currentTime;
    const lead = (cursorRef.current - now) * 1000;
    // Underrun (the cursor is in the past) or a runaway queue: snap back to the target lead.
    // Without this the first case plays everything late forever and the second drifts further
    // behind the picture with every packet.
    if (lead < 0 || lead > MAX_LEAD_MS) cursorRef.current = now + TARGET_LEAD_MS / 1000;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    if (destRef.current) source.connect(destRef.current);
    source.start(cursorRef.current);
    cursorRef.current += buffer.duration;
  }, []);

  const configure = useCallback(async (channels: number, sampleRate: number) => {
    if (typeof AudioDecoder === "undefined" || typeof AudioContext === "undefined") {
      setStatus("unsupported");
      return;
    }
    reset();
    const ctx = new AudioContext({ sampleRate, latencyHint: "interactive" });
    ctxRef.current = ctx;
    // Autoplay policy: a context created without a user gesture starts suspended, and
    // `resume()` only succeeds once the page has one. The toggle that turns audio on *is* a
    // click, so by the time this runs there has been one.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    destRef.current = ctx.createMediaStreamDestination();

    const decoder = new AudioDecoder({
      output: play,
      // A decode error is one bad packet, not a dead stream: Opus frames are independent, so
      // the next one decodes fine. Resetting instead of closing keeps the stream alive.
      error: () => { try { decoderRef.current?.reset(); } catch { /* gone */ } },
    });
    try {
      decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
    } catch {
      setStatus("unsupported");
      return;
    }
    decoderRef.current = decoder;
    cursorRef.current = 0;
    timestampRef.current = 0;
    setStatus("playing");
  }, [play, reset]);

  const decodePacket = useCallback((packet: Uint8Array) => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== "configured") return;
    // Timestamps have to advance monotonically or the decoder rejects the chunk, and the host
    // sends no per-packet pts — so they are counted here at the one frame duration the encoder
    // is pinned to (`-frame_duration 20`).
    const timestamp = timestampRef.current;
    timestampRef.current += 20_000;
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data: packet }));
    } catch { /* a chunk the decoder refused; the next one is independent */ }
  }, []);

  const getTracks = useCallback(
    () => (destRef.current ? destRef.current.stream.getAudioTracks() : []),
    [],
  );

  useEffect(() => () => reset(), [reset]);

  return { status, configure, decodePacket, reset, getTracks };
}
