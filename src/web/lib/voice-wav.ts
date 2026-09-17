/**
 * Turning what `MediaRecorder` produced into what whisper.cpp reads.
 *
 * The browser records Opus in WebM (Chrome), Opus in Ogg (Firefox) or AAC in
 * MP4 (Safari); whisper.cpp reads wav, flac, mp3 and Vorbis-ogg — so none of
 * them, and converting on the host would mean requiring ffmpeg there. The
 * browser already has a decoder for its own recording, so the conversion
 * happens here.
 *
 * `decodeAudioData` resamples to the context's rate, which is why the context
 * is created at 16 kHz: that is Whisper's own rate, and it makes the upload a
 * third of what 48 kHz would cost (32 KB per second of speech).
 */

export const WHISPER_SAMPLE_RATE = 16_000;

/** Average the channels; Whisper takes mono and a stereo mic gains it nothing. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]!.length;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}

/** 16-bit PCM WAV: a 44-byte header and the samples, clamped to [-1, 1). */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Decode a recording and re-encode it as a 16 kHz mono WAV. */
export async function recordingToWav(blob: Blob): Promise<Uint8Array> {
  const ctx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let i = 0; i < decoded.numberOfChannels; i++) channels.push(decoded.getChannelData(i));
  // Header takes the buffer's own rate: a browser that declines to resample
  // still produces a correct file, and whisper.cpp resamples it on its side.
  return encodeWavPcm16(mixToMono(channels), decoded.sampleRate);
}
