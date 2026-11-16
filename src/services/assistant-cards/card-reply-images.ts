/**
 * Images on the user's reply to a PPM Assistant card (from PPM or from Telegram).
 *
 * The caller hands over payloads only — base64 and a media type — and never a path: the server
 * decides where each image is written, under a name it generates, so a reply cannot point the
 * manager chat at any file of its choosing. Validation is pure and runs before anything is
 * written; a reply refused for any reason leaves nothing on disk.
 *
 * The bytes are checked against the declared type by their signature, not trusted from the
 * label: a model given "image/png" that is really something else either errors on the turn or
 * reads it wrong, and the file written beside it would carry a misleading extension.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUploadsDir } from "../chat-upload-storage.service.ts";

export const MAX_REPLY_IMAGES = 5;
export const MAX_REPLY_IMAGE_BYTES = 5 * 1024 * 1024;
/** The longest base64 that can decode to at most {@link MAX_REPLY_IMAGE_BYTES}; checked before decoding. */
const MAX_BASE64_CHARS = Math.ceil(MAX_REPLY_IMAGE_BYTES / 3) * 4;

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A payload that passed every check, with its decoded bytes kept for the write. */
export interface ValidReplyImage { data: string; mediaType: string; bytes: Buffer }
/** An image as it is forwarded: the payload for Claude, the server-written file for Codex. */
export interface ReplyImage { data: string; mediaType: string; path: string }

export type ReplyImagesCheck = { ok: true; images: ValidReplyImage[] } | { ok: false; error: string };

const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function startsWith(bytes: Buffer, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((b, i) => bytes[at + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Whether the bytes carry the signature of the declared image type. */
export function bytesMatchMediaType(bytes: Buffer, mediaType: string): boolean {
  switch (mediaType) {
    case "image/png": return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg": return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif": return startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
    case "image/webp": return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    default: return false;
  }
}

/**
 * Checks the `images` of a reply body: absent or empty is fine; otherwise at most five, each a
 * supported type whose base64 decodes cleanly to at most 5 MB of bytes that really are that type.
 * Only `data` and `mediaType` are read from each entry; anything else on it (a `path`) is ignored.
 */
export function validateReplyImages(raw: unknown): ReplyImagesCheck {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "images must be a list" };
  if (raw.length > MAX_REPLY_IMAGES) return { ok: false, error: `A reply may carry at most ${MAX_REPLY_IMAGES} images` };
  const images: ValidReplyImage[] = [];
  for (const [i, entry] of raw.entries()) {
    const n = `Image ${i + 1}`;
    if (!entry || typeof entry !== "object") return { ok: false, error: `${n} is not an image` };
    const { data, mediaType } = entry as Record<string, unknown>;
    if (typeof mediaType !== "string" || !EXTENSIONS[mediaType]) {
      return { ok: false, error: `${n} must be a PNG, JPEG, GIF or WebP image` };
    }
    if (typeof data !== "string" || !data) return { ok: false, error: `${n} has no data` };
    if (data.length > MAX_BASE64_CHARS) return { ok: false, error: `${n} is larger than 5 MB` };
    if (data.length % 4 !== 0 || !STRICT_BASE64_RE.test(data)) return { ok: false, error: `${n} is not valid base64` };
    const bytes = Buffer.from(data, "base64");
    // Round-tripping catches what the pattern lets through (stray bits after the last byte).
    if (bytes.toString("base64") !== data) return { ok: false, error: `${n} is not valid base64` };
    if (bytes.length > MAX_REPLY_IMAGE_BYTES) return { ok: false, error: `${n} is larger than 5 MB` };
    if (!bytesMatchMediaType(bytes, mediaType)) return { ok: false, error: `${n} is not the ${EXTENSIONS[mediaType]!.toUpperCase()} image it says it is` };
    images.push({ data, mediaType, bytes });
  }
  return { ok: true, images };
}

/**
 * Writes each image into PPM's uploads folder under a name the server makes up
 * (`card-<8 hex>.<ext>`), where the chat's history can draw it from later. All or nothing: a write
 * that fails removes the ones already written and throws.
 */
export function writeReplyImages(images: readonly ValidReplyImage[], dir: string = ensureUploadsDir()): ReplyImage[] {
  const written: ReplyImage[] = [];
  try {
    for (const img of images) {
      const path = join(dir, `card-${crypto.randomUUID().slice(0, 8)}.${EXTENSIONS[img.mediaType]}`);
      // `wx`: a name that already exists is never overwritten.
      writeFileSync(path, img.bytes, { flag: "wx" });
      written.push({ data: img.data, mediaType: img.mediaType, path });
    }
  } catch (e) {
    for (const w of written) {
      try { unlinkSync(w.path); } catch { /* already gone: nothing to undo */ }
    }
    throw e;
  }
  return written;
}
