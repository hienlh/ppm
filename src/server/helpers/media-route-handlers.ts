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
  stopTranscode,
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

/** Accept only a short opaque id so a hostile query cannot bloat the session map. */
function parseSessionId(raw: string | undefined): string | undefined {
  return raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : undefined;
}

/**
 * GET …/transcode?path=&start=&sid= → live fragmented-MP4 body.
 * `sid` identifies the player; its previous job is killed before this one starts.
 */
export async function handleMediaTranscode(absPath: string, req: Request, startRaw?: string, sidRaw?: string): Promise<Response> {
  try {
    const job = await startTranscode(absPath, { start: parseStart(startRaw), signal: req.signal, sessionId: parseSessionId(sidRaw) });
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

/**
 * DELETE …/transcode?sid= → kill the player's job. Needed because a proxy in front of
 * PPM (Cloudflare Tunnel) may keep the origin request alive after the browser left.
 */
export function handleMediaTranscodeStop(sidRaw?: string): Response {
  const sid = parseSessionId(sidRaw);
  if (!sid) return Response.json(err("sid is required"), { status: 400 });
  return Response.json(ok({ stopped: stopTranscode(sid) }));
}
