/**
 * Plays the page's sound: chunks of signed 16-bit PCM scheduled back to back on one
 * `AudioContext`. `AudioBufferSourceNode` scheduling works on plain-HTTP origins, where neither
 * `AudioDecoder` nor `AudioWorklet` exists, which is why the stream is raw PCM.
 *
 * The play head is kept a little ahead of the clock (`LEAD_S`) to absorb jitter, and resynced
 * when it falls behind or drifts too far ahead, so a stall costs a short gap rather than an
 * ever-growing delay.
 */
import type { SoundFrame } from "../../../shared/web-browser-binary-frames";

const LEAD_S = 0.12;
const MAX_AHEAD_S = 0.6;

/** Pure: int16 little-endian interleaved → one Float32Array per channel. */
export function pcm16ToChannels(bytes: Uint8Array, channels: number): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / 2 / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c]![i] = view.getInt16((i * channels + c) * 2, true) / 32768;
  }
  return out;
}

/** Pure: when the next chunk should start, given the clock and the scheduled play head. */
export function nextStartTime(now: number, playHead: number): number {
  if (playHead < now + 0.02 || playHead > now + MAX_AHEAD_S) return now + LEAD_S;
  return playHead;
}

export class PcmAudioPlayer {
  private ctx: AudioContext | null = null;
  private playHead = 0;

  resume(): void {
    if (typeof AudioContext === "undefined") return;
    this.ctx ??= new AudioContext();
    void this.ctx.resume().catch(() => {});
  }

  push(frame: SoundFrame): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || frame.channels < 1 || frame.sampleRate < 8000) return;
    const channels = pcm16ToChannels(frame.payload, frame.channels);
    const length = channels[0]?.length ?? 0;
    if (!length) return;
    const buffer = ctx.createBuffer(frame.channels, length, frame.sampleRate);
    channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const start = nextStartTime(ctx.currentTime, this.playHead);
    node.start(start);
    this.playHead = start + buffer.duration;
  }

  close(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
