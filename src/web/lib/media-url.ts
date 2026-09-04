/**
 * URL builders for media the browser fetches on its own (`<video src>`, `<audio src>`).
 *
 * Those elements cannot send an Authorization header, so the session token rides in
 * the query string — the server only accepts `?token=` on these exact routes.
 * Streaming straight from the URL (instead of fetching a blob first) lets the browser
 * issue Range requests, so a multi-GB file starts playing immediately and seeking
 * costs one small request.
 */
import { api, getAuthToken, projectUrl } from "@/lib/api-client";

/** Absolute (`/x`, `C:\x`) paths belong to the whole-disk `/api/fs` routes, relative ones to the project. */
export function isExternalPath(filePath: string): boolean {
  return /^(\/|[A-Za-z]:[/\\])/.test(filePath);
}

/** `/api/fs/<route>` or `/api/project/<name>/files/<route>` depending on the path kind. */
function mediaBase(route: "raw" | "transcode" | "probe", filePath: string, projectName: string): string {
  const prefix = isExternalPath(filePath) ? "/api/fs" : `${projectUrl(projectName)}/files`;
  return `${prefix}/${route}?path=${encodeURIComponent(filePath)}`;
}

function withToken(url: string): string {
  const token = getAuthToken();
  return token ? `${url}&token=${encodeURIComponent(token)}` : url;
}

/** Direct, Range-capable URL of the file as stored on disk. */
export function rawMediaUrl(filePath: string, projectName: string): string {
  return withToken(mediaBase("raw", filePath, projectName));
}

/**
 * Live ffmpeg → fragmented-MP4 stream starting at `start` seconds.
 * `sessionId` identifies the player instance: the server kills that player's previous
 * job before starting this one, so a seek never leaves an orphaned ffmpeg behind —
 * even through proxies (Cloudflare Tunnel) that do not propagate client disconnects.
 */
export function transcodeMediaUrl(filePath: string, projectName: string, start = 0, sessionId?: string): string {
  let url = mediaBase("transcode", filePath, projectName);
  if (start > 0) url += `&start=${start.toFixed(3)}`;
  if (sessionId) url += `&sid=${encodeURIComponent(sessionId)}`;
  return withToken(url);
}

/**
 * Tell the server the player is gone so its ffmpeg job stops now. `keepalive` lets the
 * request complete even when fired from a page that is unloading.
 */
export function stopTranscode(filePath: string, projectName: string, sessionId: string): void {
  const prefix = isExternalPath(filePath) ? "/api/fs" : `${projectUrl(projectName)}/files`;
  const token = getAuthToken();
  void fetch(`${prefix}/transcode?sid=${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    keepalive: true,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => {});
}

/** Short random id for one mounted player. */
export function newMediaSessionId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export interface MediaProbeInfo {
  transcodable: boolean;
  encoder: string | null;
  duration: number | null;
  container: string | null;
  video: { codec: string; width?: number; height?: number } | null;
  audio: { codec: string } | null;
}

/** Ask the server what the file contains and whether it can transcode it. */
export function probeMedia(filePath: string, projectName: string): Promise<MediaProbeInfo> {
  return api.get<MediaProbeInfo>(mediaBase("probe", filePath, projectName));
}
