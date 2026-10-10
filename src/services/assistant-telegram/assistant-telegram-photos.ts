/**
 * A photo sent to the bot, fetched so it can go into the Assistant's turn as an image.
 *
 * Telegram sends every size it made of a photo, smallest first. The largest one that fits under
 * the cap is taken — a screenshot of an error is only useful if it can be read — and the download
 * itself refuses anything over the cap whatever the size Telegram declared.
 */
import type { TelegramBotClient } from "../telegram/telegram-bot-client.ts";
import type { TelegramPhotoSize } from "../telegram/telegram-types.ts";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

export type PhotoResult = { ok: true; image: { data: string; mediaType: string } } | { ok: false; reason: string };

/** The size to fetch: the largest that declares itself under the cap (or declares nothing). */
export function pickPhotoSize(sizes: readonly TelegramPhotoSize[]): TelegramPhotoSize | null {
  const fitting = sizes.filter((s) => s.file_size === undefined || s.file_size <= MAX_PHOTO_BYTES);
  if (!fitting.length) return null;
  return fitting.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best));
}

export async function fetchPhoto(client: TelegramBotClient, sizes: readonly TelegramPhotoSize[]): Promise<PhotoResult> {
  const size = pickPhotoSize(sizes);
  if (!size) return { ok: false, reason: "The photo is larger than 5 MB." };
  const file = await client.getFile(size.file_id);
  if (!file.ok || !file.result.file_path) return { ok: false, reason: "Telegram did not hand over the photo." };
  const ext = /\.(\w+)$/.exec(file.result.file_path)?.[1]?.toLowerCase() ?? "jpg";
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) return { ok: false, reason: "That kind of image is not supported." };
  const bytes = await client.downloadFile(file.result.file_path, MAX_PHOTO_BYTES);
  if (!bytes.ok) return { ok: false, reason: bytes.description === "file too large" ? "The photo is larger than 5 MB." : "The photo could not be downloaded." };
  return { ok: true, image: { data: Buffer.from(bytes.result).toString("base64"), mediaType } };
}
