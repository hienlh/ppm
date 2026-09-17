/**
 * Host audio → client: one ffmpeg per session capturing what the host is *playing* (not its
 * microphone) and encoding it as Opus in Ogg, which `remote-desktop-ogg-opus.ts` unwraps into
 * packets the browser's `AudioDecoder` takes directly.
 *
 * The hard part is not the encode, it is that only one of the three platforms can capture its
 * own output without help:
 *
 * - **Linux**: PulseAudio and PipeWire both expose every sink's *monitor* as a capture source,
 *   and `@DEFAULT_MONITOR@` resolves to the current default sink's — so this follows the user
 *   switching from speakers to headphones with no re-detection. Needs ffmpeg built with
 *   `pulse` (checked, not assumed: a minimal build has ALSA only, and `-f pulse` on one of
 *   those fails at spawn with "Unknown input format").
 * - **Windows**: ffmpeg has no WASAPI loopback input. The only route is DirectShow, and a
 *   loopback DirectShow device is something the host must already have — "Stereo Mix", which
 *   most drivers ship disabled, or a virtual cable. So this reports unavailable with the
 *   device name to enable rather than spawning an ffmpeg that exits instantly.
 * - **macOS**: avfoundation can only capture real inputs; there is no system-audio device at
 *   all without a loopback driver (BlackHole). Same treatment.
 *
 * `-application lowdelay` + `-frame_duration 20` keeps the encoder's own delay at one frame,
 * and `-page_duration 20000` is load-bearing: the Ogg muxer's default is **one second**, which
 * measured 2000 ms between writes on this host — two seconds of audio latency against video
 * arriving in twenty milliseconds. With it, pages land every ~40 ms.
 */
import { existsSync } from "node:fs";
import { getFfmpegCapabilities } from "../media-transcode/ffmpeg-capabilities.ts";
import { detectLinuxSession, linuxSessionEnv } from "./remote-desktop-linux-session.ts";
import { OggOpusDemuxer } from "./remote-desktop-ogg-opus.ts";

/** Opus always decodes at 48 kHz whatever the source rate was. */
export const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = "96k";
/** One Opus frame. Also the Ogg page duration, in microseconds, for the reason above. */
const FRAME_MS = 20;

export interface AudioSupport {
  available: boolean;
  /** Why not, and what the user can do about it. Null when audio works. */
  reason: string | null;
}

/** The ffmpeg input for this host's own output, or null when it has none. */
export function audioInputArgs(
  platform: NodeJS.Platform = process.platform,
  hasPulse = pulseAvailable(),
): string[] | null {
  if (platform !== "linux" || !hasPulse) return null;
  return ["-f", "pulse", "-i", "@DEFAULT_MONITOR@"];
}

/** Is there a PulseAudio/PipeWire server to talk to? The socket, not `pactl`: the binary is a
 *  separate package (the same `xrandr` vs `libXrandr` trap), and a PPM started by its systemd
 *  unit has `XDG_RUNTIME_DIR` even when it has no `DISPLAY`. */
export function pulseAvailable(runtimeDir = process.env.XDG_RUNTIME_DIR): boolean {
  if (!runtimeDir) return false;
  return existsSync(`${runtimeDir}/pulse/native`);
}

/** Whether this ffmpeg build has the `pulse` demuxer at all — a minimal build has ALSA only,
 *  and `-f pulse` there fails at spawn rather than degrading. */
export async function ffmpegHasPulse(ffmpeg: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([ffmpeg, "-hide_banner", "-demuxers"], {
      stdout: "pipe", stderr: "ignore", stdin: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    // `ffmpeg -demuxers` writes " D d pulse           Pulse audio input" — flags, then a
    // *space-separated* name. Anchoring on the flag column rather than on the whole line keeps
    // this working for both the `-demuxers` and `-devices` spellings (" DE pulse").
    return /^\s*D\S*\s+(?:\S+\s+)?pulse\s/m.test(text);
  } catch {
    return false;
  }
}

/** Can this host stream its own audio, and if not, what should the user do. */
export async function audioSupport(platform: NodeJS.Platform = process.platform): Promise<AudioSupport> {
  if (platform === "win32") {
    return {
      available: false,
      reason: "Windows has no loopback capture ffmpeg can use — enable \"Stereo Mix\" in Sound "
        + "settings, or install a virtual audio cable.",
    };
  }
  if (platform === "darwin") {
    return {
      available: false,
      reason: "macOS has no system-audio input — install a loopback driver such as BlackHole.",
    };
  }
  if (platform !== "linux") return { available: false, reason: "Not supported on this platform." };
  if (!pulseAvailable()) {
    return { available: false, reason: "No PulseAudio/PipeWire server is running on the host." };
  }
  const { ffmpeg } = await getFfmpegCapabilities();
  if (!ffmpeg) return { available: false, reason: "ffmpeg is not installed." };
  if (!await ffmpegHasPulse(ffmpeg)) {
    return { available: false, reason: "This ffmpeg build has no PulseAudio support." };
  }
  return { available: true, reason: null };
}

/** Full argv, pure so it can be asserted without spawning. */
export function buildAudioArgs(ffmpeg: string, input: string[]): string[] {
  return [
    ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
    "-fflags", "nobuffer", "-flags", "low_delay",
    ...input,
    "-c:a", "libopus", "-b:a", AUDIO_BITRATE,
    // `lowdelay` disables the encoder's look-ahead; without it Opus adds its own ~100ms.
    "-application", "lowdelay", "-frame_duration", String(FRAME_MS),
    "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2",
    "-page_duration", String(FRAME_MS * 1000),
    "-flush_packets", "1", "-f", "ogg", "pipe:1",
  ];
}

export interface AudioHandle {
  stop(): void;
}

export interface StartAudioOptions {
  /** One decoded Opus packet, ready for `AudioDecoder`. */
  onPacket: (packet: Uint8Array) => void;
  /** Channel layout, once the stream header has been parsed. Fires before the first packet. */
  onStreamInfo: (info: { channels: number; sampleRate: number }) => void;
  onExit?: (code: number | null, reason?: string) => void;
}

/** Start capturing host audio, or return null when this host cannot (see `audioSupport`).
 *  Never throws for an unsupported host: audio is an extra, and a session must not fail to
 *  start because the machine has no loopback device. */
export async function startAudioCapture(opts: StartAudioOptions): Promise<AudioHandle | null> {
  const { ffmpeg } = await getFfmpegCapabilities();
  if (!ffmpeg) return null;
  const support = await audioSupport();
  if (!support.available) return null;
  const input = audioInputArgs();
  if (!input) return null;

  const session = process.platform === "linux" ? detectLinuxSession() : null;
  const proc = Bun.spawn(buildAudioArgs(ffmpeg, input), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    ...(session ? { env: { ...process.env, ...linuxSessionEnv(session) } } : {}),
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // SIGKILL for the same reason the video capture uses it — see `remote-desktop-capture.ts`.
    if (!proc.killed) proc.kill("SIGKILL");
  };

  const stderrTail = new Response(proc.stderr).text().catch(() => "");
  proc.exited.then(async (code) => {
    const diedOnItsOwn = !stopped;
    stopped = true;
    let reason: string | undefined;
    if (diedOnItsOwn && code !== 0 && code !== null) {
      reason = (await stderrTail).trim().split("\n").slice(-2).join(" | ");
      console.warn(`[remote-desktop] audio ffmpeg exited ${code}: ${reason}`);
    }
    opts.onExit?.(code, reason);
  });

  const demuxer = new OggOpusDemuxer();
  let announced = false;
  // Manual pull loop, never `for await`: cancelling this reader is what segfaults Bun on
  // Windows (see `remote-desktop-capture.ts`'s header). `stop()` kills the process and the
  // pending `read()` resolves done.
  const reader = proc.stdout.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      const packets = demuxer.push(value);
      const info = demuxer.info;
      if (!announced && info) {
        announced = true;
        opts.onStreamInfo({ channels: info.channels, sampleRate: AUDIO_SAMPLE_RATE });
      }
      for (const p of packets) opts.onPacket(p);
    }
  })();

  return { stop };
}
