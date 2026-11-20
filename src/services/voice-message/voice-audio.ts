/**
 * Audio in, a WAV whisper.cpp can read out. whisper.cpp reads WAV, FLAC, MP3 and Vorbis-Ogg only,
 * and a Telegram voice note is Opus in Ogg — so anything that is not already a WAV goes through
 * ffmpeg into 16 kHz mono 16-bit PCM, the format the model works in. A browser recording arrives
 * as WAV and never needs ffmpeg.
 *
 * ffmpeg reads and writes temp files rather than pipes: a WAV written to a pipe cannot be
 * rewound to fill in its header's sizes, and some containers need a seekable input.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { findFfmpegBinary } from "../media-transcode/ffmpeg-capabilities.ts";
import { whisperTmpDir } from "../speech-to-text/whisper-paths.ts";
import { VOICE_MAX_SECONDS } from "../../shared/voice-message.ts";
import { VoiceMessageError } from "./voice-message-errors.ts";

const CONVERT_TIMEOUT_MS = 60_000;

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

/** A RIFF/WAVE file, by its first twelve bytes. */
export function isWav(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/**
 * Seconds of audio in a PCM WAV, from its `fmt ` byte rate and its `data` chunk size (the size is
 * capped at what the file really holds, for a header written before the recording ended). Null
 * when the chunks are not there.
 */
export function wavDurationSec(bytes: Uint8Array): number | null {
  if (!isWav(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let byteRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= bytes.byteLength) byteRate = view.getUint32(body + 8, true);
    if (id === "data") {
      if (byteRate <= 0) return null;
      return Math.min(size, bytes.byteLength - body) / byteRate;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/**
 * Seconds ffmpeg reads before it stops. A 25 MB compressed file can hold hours, which would decode
 * into hundreds of MB before the duration check ever saw it. The cap sits past the longest length
 * the service accepts (2:00 plus its slack), so an over-long file still comes out over that length
 * and is refused as too long rather than silently cut to two minutes.
 */
export const DECODE_LIMIT_SEC = VOICE_MAX_SECONDS + 10;

/** ffmpeg's arguments: read at most {@link DECODE_LIMIT_SEC} of `input`, write 16 kHz mono PCM WAV. */
export function ffmpegWavArgs(ffmpeg: string, input: string, output: string): string[] {
  return [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-t", String(DECODE_LIMIT_SEC), "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", output];
}

// Named so `ReturnType` keeps the narrowed pipe type; `typeof Bun.spawn` widens stderr to a union.
const spawnFfmpeg = (cmd: string[]) =>
  Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });

/** `audio` as a WAV whisper can read. Throws a {@link VoiceMessageError} when it cannot be made one. */
export async function toWhisperWav(audio: Uint8Array): Promise<Uint8Array> {
  if (isWav(audio)) return audio;
  const ffmpeg = findFfmpegBinary("ffmpeg");
  if (!ffmpeg) {
    throw new VoiceMessageError("ffmpeg_missing", "Reading this audio needs ffmpeg on the PPM host (a WAV recording does not)");
  }
  mkdirSync(whisperTmpDir(), { recursive: true });
  const id = randomUUID();
  const input = resolve(whisperTmpDir(), `${id}.in`);
  const output = resolve(whisperTmpDir(), `${id}.wav`);
  try {
    await Bun.write(input, audio);
    const cmd = ffmpegWavArgs(ffmpeg, input, output);
    let proc: ReturnType<typeof spawnFfmpeg>;
    try {
      proc = spawnFfmpeg(cmd);
    } catch (e) {
      // Bun.spawn throws, rather than failing the run, when the binary vanished since the lookup.
      throw new VoiceMessageError("ffmpeg_missing", `Could not start ffmpeg: ${(e as Error).message}`);
    }
    const timer = setTimeout(() => proc.kill(), CONVERT_TIMEOUT_MS);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) {
      const detail = stderr.trim().split("\n").slice(-1)[0] || `exit ${code}`;
      throw new VoiceMessageError("unreadable_audio", `ffmpeg could not read this audio: ${detail}`);
    }
    const wav = new Uint8Array(await Bun.file(output).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!isWav(wav)) throw new VoiceMessageError("unreadable_audio", "ffmpeg produced no audio from this file");
    return wav;
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
}
