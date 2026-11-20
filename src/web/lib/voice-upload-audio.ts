/**
 * A voice recording PPM stored, read back in the browser. The uploads route takes the token as a
 * header only, so an `<audio src>` cannot reach it: the bytes are fetched with the header and
 * played from a blob URL. Used by the sent bubble and by the composer's chip once the draft came
 * back from storage (a reload, another device) and this browser no longer holds the recording.
 */
import { getAuthToken } from "@/lib/api-client";

/** The recording's bytes; throws on any status but 2xx. */
export async function fetchUploadedAudio(src: string, signal?: AbortSignal): Promise<Blob> {
  const token = getAuthToken();
  const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

// Kept for the page's life: uploads never change, and a player may still be using the URL.
const audioUrlCache = new Map<string, Promise<string>>();

/** A playable blob URL for an uploaded recording, fetched once per page. */
export function loadUploadedAudioUrl(src: string): Promise<string> {
  let pending = audioUrlCache.get(src);
  if (!pending) {
    pending = fetchUploadedAudio(src).then((blob) => URL.createObjectURL(blob));
    // A failure is not remembered: the next press tries again.
    pending.catch(() => audioUrlCache.delete(src));
    audioUrlCache.set(src, pending);
  }
  return pending;
}
