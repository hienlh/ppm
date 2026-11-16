/**
 * A photo sent to the bot, fetched so it can go into a turn as an image.
 *
 * Telegram sends every size it made of a photo, smallest first. The largest one that fits is
 * taken — a screenshot of an error is only useful if it can be read — where fitting means under
 * the byte cap and under the API's per-image pixel limit on its longer side: once a request
 * carries several images the API refuses any that large, and that refusal fails every later turn.
 * The download itself refuses anything over the cap whatever the size Telegram declared.
 */
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { TelegramPhotoSize } from "../telegram/telegram-types.ts";
import { MAX_IMAGE_DIMENSION } from "../../shared/image-limits.ts";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export type PhotoResult = { ok: true; image: { data: string; mediaType: string } } | { ok: false; reason: string };

/** A byte cap and how it is said to a person ("5 MB"). */
export interface PhotoCap { maxBytes: number; sizeText: string }
const DEFAULT_CAP: PhotoCap = { maxBytes: MAX_PHOTO_BYTES, sizeText: "5 MB" };

/**
 * The size to fetch: the largest under the pixel limit on its longer side that declares itself
 * under the byte cap (or declares no size at all).
 */
export function pickPhotoSize(sizes: readonly TelegramPhotoSize[], maxBytes: number = MAX_PHOTO_BYTES): TelegramPhotoSize | null {
  const fitting = sizes.filter((s) => (s.file_size === undefined || s.file_size <= maxBytes)
    && Math.max(s.width, s.height) < MAX_IMAGE_DIMENSION);
  if (!fitting.length) return null;
  return fitting.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best));
}

/**
 * The photos of one message or album, at most `max` of them, in order: what was fetched, why each
 * photo that was not failed, and how many were left out over the limit. Never throws: a network
 * error is one more failure to tell the user about.
 */
export async function fetchPhotos(
  client: TelegramBotClient, photos: ReadonlyArray<readonly TelegramPhotoSize[]>, max: number, cap: PhotoCap = DEFAULT_CAP,
): Promise<{ images: Array<{ data: string; mediaType: string }>; failures: string[]; dropped: number }> {
  const images: Array<{ data: string; mediaType: string }> = [];
  const failures: string[] = [];
  for (const sizes of photos.slice(0, max)) {
    let result: PhotoResult;
    try {
      result = await fetchPhoto(client, sizes, cap);
    } catch {
      result = { ok: false, reason: "The photo could not be downloaded." };
    }
    if (result.ok) images.push(result.image);
    else failures.push(result.reason);
  }
  return { images, failures, dropped: Math.max(0, photos.length - max) };
}

export async function fetchPhoto(client: TelegramBotClient, sizes: readonly TelegramPhotoSize[], cap: PhotoCap = DEFAULT_CAP): Promise<PhotoResult> {
  const size = pickPhotoSize(sizes, cap.maxBytes);
  if (!size) {
    const bytesFit = sizes.some((s) => s.file_size === undefined || s.file_size <= cap.maxBytes);
    return { ok: false, reason: bytesFit ? `The photo is too large: Telegram has no copy under ${MAX_IMAGE_DIMENSION} pixels a side.` : `The photo is larger than ${cap.sizeText}.` };
  }
  const file = await client.getFile(size.file_id);
  if (!file.ok || !file.result.file_path) return { ok: false, reason: "Telegram did not hand over the photo." };
  const ext = /\.(\w+)$/.exec(file.result.file_path)?.[1]?.toLowerCase() ?? "jpg";
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) return { ok: false, reason: "That kind of image is not supported." };
  const bytes = await client.downloadFile(file.result.file_path, cap.maxBytes);
  if (!bytes.ok) return { ok: false, reason: bytes.description === "file too large" ? `The photo is larger than ${cap.sizeText}.` : "The photo could not be downloaded." };
  return { ok: true, image: { data: Buffer.from(bytes.result).toString("base64"), mediaType } };
}
