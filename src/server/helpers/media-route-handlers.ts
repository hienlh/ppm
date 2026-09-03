/**
 * Shared bodies for the `/probe` and `/transcode` media routes.
 *
 * Both the project-scoped router (`/api/project/:name/files/*`) and the whole-disk
 * router (`/api/fs/*`) expose them; each resolves and authorises its own path and
 * then delegates here, so the ffmpeg handling lives in exactly one place.
 */
import { getFfmpegCapabilities } from "../../services/media-transcode/ffmpeg-capabilities.ts";
import { probeMedia } from "../../services/media-transcode/media-probe.ts";
import {
  startTranscode,
  TranscodeBusyError,
  TranscodeUnavailableError,
} from "../../services/media-transcode/transcode-stream.ts";
import { ok, err } from "../../types/api.ts";

/** What the player needs to decide between native playback and transcoding. */
export interface MediaProbeResponse {
  /** ffmpeg present with a usable encoder — the `/transcode` route will work. */
  transcodable: boolean;
  encoder: string | null;
  duration: number | null;
  container: string | null;
  video: { codec: string; width?: number; height?: number } | null;
  audio: { codec: string } | null;
}

/** GET …/probe?path= → codec/duration facts plus whether transcoding is available. */
export async function handleMediaProbe(absPath: string): Promise<Response> {
  const caps = await getFfmpegCapabilities();
  const probe = await probeMedia(absPath);
  const body: MediaProbeResponse = {
    transcodable: Boolean(caps.ffmpeg && caps.encoder),
    encoder: caps.encoder,
    duration: probe?.duration ?? null,
    container: probe?.container ?? null,
    video: probe?.video ?? null,
    audio: probe?.audio ? { codec: probe.audio.codec } : null,
  };
  return Response.json(ok(body));
}

/** Parse `?start=` seconds; garbage or negatives become 0. */
function parseStart(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** GET …/transcode?path=&start= → live fragmented-MP4 body. */
export async function handleMediaTranscode(absPath: string, req: Request, startRaw?: string): Promise<Response> {
  try {
    const job = await startTranscode(absPath, { start: parseStart(startRaw), signal: req.signal });
    return new Response(job.stream, {
      headers: {
        "Content-Type": "video/mp4",
        // The body is generated per request; nothing about it is reusable.
        "Cache-Control": "no-store",
        "X-PPM-Encoder": job.encoder,
      },
    });
  } catch (e) {
    if (e instanceof TranscodeUnavailableError) return Response.json(err(e.message), { status: 501 });
    if (e instanceof TranscodeBusyError) return Response.json(err(e.message), { status: 503 });
    throw e;
  }
}
