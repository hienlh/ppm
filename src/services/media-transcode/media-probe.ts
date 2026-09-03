/**
 * Read container/codec facts about a media file with ffprobe.
 *
 * The transcoded stream the player receives is a live fragmented MP4 with no
 * duration, so the UI needs the real duration from here to draw a seek bar.
 */
import { getFfmpegCapabilities } from "./ffmpeg-capabilities.ts";

export interface MediaStreamInfo {
  codec: string;
  width?: number;
  height?: number;
}

export interface MediaProbe {
  /** Seconds; null when ffprobe could not determine it. */
  duration: number | null;
  container: string | null;
  video: MediaStreamInfo | null;
  audio: MediaStreamInfo | null;
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
}

/** Returns null when ffprobe is unavailable or the file is not media it understands. */
export async function probeMedia(absPath: string): Promise<MediaProbe | null> {
  const { ffprobe } = await getFfmpegCapabilities();
  if (!ffprobe) return null;

  const proc = Bun.spawn(
    [
      ffprobe, "-v", "error", "-of", "json",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
      absPath,
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) return null;

  let json: FfprobeJson;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const pick = (type: string): MediaStreamInfo | null => {
    const s = json.streams?.find((x) => x.codec_type === type && x.codec_name);
    return s ? { codec: s.codec_name!, width: s.width, height: s.height } : null;
  };
  const duration = Number(json.format?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    container: json.format?.format_name ?? null,
    video: pick("video"),
    audio: pick("audio"),
  };
}
