/**
 * Files a manager chat attaches to a report card (`report_to_assistant { files }`): a clip, an
 * original picture, a PDF, a zip. PPM copies each into its own store when the report is filed, so
 * the card keeps what was sent even if the file on disk changes or goes; the card and Telegram
 * read only that copy. Shared by the server (store, route, Telegram) and the card in the browser.
 *
 * What a file *is* comes from its first bytes, never from its name: a `.png` that is really HTML
 * is `other`, downloaded and never shown inline.
 */

/** How a card shows a file: a picture, a video, a PDF, or a download. */
export type CardFileKind = "image" | "video" | "pdf" | "other";

/** One file on a card: PPM's copy, by id, and what it was. */
export interface CardFile {
  /** 32 hex characters; names the copy under `<ppm dir>/card-files/`. */
  id: string;
  /** The file's own name (no folder). */
  name: string;
  /** Bytes. */
  size: number;
  kind: CardFileKind;
  /** The type PPM serves it as: one of {@link PREVIEW_MIME_TYPES} for a preview, else octet-stream. */
  mime: string;
  /** sha256 of the copy, hex: two reports attaching the same file are the same report. */
  sha256: string;
}

/** Files one card carries at most. */
export const REPORT_FILES_MAX = 6;
/** The largest file PPM copies onto a card. */
export const CARD_FILE_MAX_BYTES = 500 * 1024 * 1024;
/** The longest path a report may name. */
export const REPORT_FILE_PATH_MAX = 1024;
/** What the Bot API takes in one upload (sendVideo, sendDocument). */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/**
 * What a compressed video aims at: under {@link TELEGRAM_UPLOAD_MAX_BYTES} with room for the
 * container and a two-pass encode's small overshoot.
 */
export const TELEGRAM_VIDEO_TARGET_BYTES = 47 * 1024 * 1024;
export const CARD_FILE_ID_RE = /^[0-9a-f]{32}$/;

/** The app path of the page that shows one card file: `/card-file/<id>`. */
export const CARD_FILE_ROUTE = "/card-file";

/** The app path showing file `id`; prefix an origin for a link from outside PPM (Telegram). */
export function cardFileAppPath(id: string): string {
  return `${CARD_FILE_ROUTE}/${id}`;
}

/** The file id a `/card-file/<id>` address names, or null when it is not one. */
export function cardFileIdFromLocation(pathname: string): string | null {
  const m = /^\/card-file\/([0-9a-f]{32})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

/** The types a card previews; everything else is served as `application/octet-stream`. */
export const PREVIEW_MIME_TYPES = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime", "application/pdf",
] as const;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, len: number): string =>
  b.length < at + len ? "" : String.fromCharCode(...b.subarray(at, at + len));

/**
 * What the first bytes of a file say it is (at least 16 bytes for a sure answer). SVG and HTML are
 * deliberately `other`: both can carry script, so they are never shown inline.
 */
export function sniffCardFile(head: Uint8Array): { kind: CardFileKind; mime: string } {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return { kind: "image", mime: "image/gif" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (ascii(head, 0, 5) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm" };
  if (ascii(head, 4, 4) === "ftyp") {
    const brand = ascii(head, 8, 4);
    if (brand === "qt  ") return { kind: "video", mime: "video/quicktime" };
    // HEIF/AVIF stills share the box layout; they are pictures no browser previews everywhere.
    if (/^(?:heic|heix|hevc|mif1|msf1|avif|avis)$/.test(brand)) return { kind: "other", mime: "application/octet-stream" };
    // M4A is audio in the same container.
    if (brand === "M4A " || brand === "M4B ") return { kind: "other", mime: "application/octet-stream" };
    return { kind: "video", mime: "video/mp4" };
  }
  return { kind: "other", mime: "application/octet-stream" };
}

/** How Telegram is asked to carry a file, or that it cannot take it as it is. */
export type TelegramFilePlan =
  | { method: "sendDocument" }
  | { method: "compress" }
  | { method: "too_large" };

/**
 * Which Bot API call carries a file. Always `sendDocument`, pictures and videos included: a
 * document reaches the phone byte for byte, while `sendPhoto` re-encodes a picture as a smaller
 * JPEG and a video sent with `sendVideo` plays in Telegram's player, which may show a
 * lower-quality copy. The user asked for the original quality, so a file is a file. Over the 50 MB
 * upload limit a video is compressed first when ffmpeg is on the host (keeping its resolution);
 * anything else, or a video with no ffmpeg, is too large.
 */
export function telegramFilePlan(file: Pick<CardFile, "kind" | "size">, canCompress: boolean): TelegramFilePlan {
  if (file.size > TELEGRAM_UPLOAD_MAX_BYTES) {
    return file.kind === "video" && canCompress ? { method: "compress" } : { method: "too_large" };
  }
  return { method: "sendDocument" };
}

/** `27.4 MB`, `812 KB`, `90 B`: sizes as a card shows them. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
