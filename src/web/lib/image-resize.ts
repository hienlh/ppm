import { MAX_IMAGE_DIMENSION, fitWithin } from "../../shared/image-limits";
import { isAnimatedImage } from "./image-animation";

/**
 * Downscaling of attachments before they are sent.
 *
 * An image is billed by area, so a screenshot straight off a high-resolution display costs
 * several thousand tokens on every turn for the rest of the session's life — and past the
 * API's ceiling it is refused outright, which fails not just that turn but every later one,
 * since the transcript is replayed in full each time.
 *
 * Done in the browser because that is where the image already exists as pixels: the decoder
 * scales it on the way in, and the smaller file is what gets uploaded, previewed, embedded and
 * stored, so nothing downstream ever sees the oversized original.
 */

/** Longest side an attachment is reduced to. Below the API ceiling, still legible for text. */
export const ATTACHMENT_MAX_DIMENSION = 1600;

/** Media types the chat socket accepts as an inline payload. */
const INLINE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ResizeKind =
  /** Re-encoded smaller. Safe to send inline: dimensions and type are both known good. */
  | "scaled"
  /** Already small enough and of a type the socket takes. Safe to send inline unchanged. */
  | "inlineable"
  /** Could not be measured or re-encoded. Must go by path — see the note on `downscaleImage`. */
  | "asis";

export interface ResizeOutcome {
  kind: ResizeKind;
  file: File;
  /** Original dimensions, when they could be read. */
  from?: { width: number; height: number };
  /** Dimensions after scaling, when a scale happened. */
  to?: { width: number; height: number };
}

/** Canvas encodes to a handful of types; anything else round-trips as PNG. */
export function encodeType(type: string): string {
  return type === "image/jpeg" || type === "image/webp" ? type : "image/png";
}

/**
 * Return a copy of `file` scaled to fit `max`, and say whether the result may be sent inline.
 *
 * Never throws: a browser without `createImageBitmap`, an image it cannot decode (HEIC on
 * Android, AVIF, a corrupt EXIF header), or a canvas that will not encode all resolve to
 * `kind: "asis"` with the original file.
 *
 * That distinction is the point. Sending an unmeasured original inline is worse than not
 * inlining at all: an oversized payload is refused by the API, and the refusal is not confined
 * to the turn — the transcript replays it, so every later turn fails too, and the retry path
 * pushes the same bytes again. A caller that cannot scale an image must fall back to passing
 * its path, which is what the product did before inlining existed and still works.
 */
export async function downscaleImage(
  file: File,
  max: number = ATTACHMENT_MAX_DIMENSION,
): Promise<ResizeOutcome> {
  const asis: ResizeOutcome = { kind: "asis", file };
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return asis;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return asis;

  let probe: ImageBitmap;
  try {
    probe = await createImageBitmap(file);
  } catch {
    return asis;
  }

  const from = { width: probe.width, height: probe.height };
  // `fitWithin` treats its bound as an exclusive ceiling, which is right for the API's limit
  // but would re-encode an image measuring exactly the attachment target for one pixel.
  const to = fitWithin(from.width, from.height, max + 1);

  // A canvas keeps one frame, so scaling an animation throws the animation away. Send it at
  // its own size when the API will still take it, and by path when it will not — losing the
  // motion is not a trade worth making silently for a picture someone chose to send moving.
  if (to && (await isAnimatedImage(file))) {
    probe.close?.();
    return Math.max(from.width, from.height) < MAX_IMAGE_DIMENSION && INLINE_MEDIA_TYPES.has(file.type)
      ? { kind: "inlineable", file, from }
      : { kind: "asis", file, from };
  }

  if (!to) {
    probe.close?.();
    // Already small enough — inline it only if the socket takes this type as-is.
    return INLINE_MEDIA_TYPES.has(file.type)
      ? { kind: "inlineable", file, from }
      : { kind: "asis", file, from };
  }

  let bitmap = probe;
  try {
    // Let the decoder do the scaling where it can: a full-size bitmap of a phone photo is
    // tens of megabytes of RGBA held on the main thread purely to be thrown away.
    try {
      bitmap = await createImageBitmap(file, {
        resizeWidth: to.width,
        resizeHeight: to.height,
        resizeQuality: "high",
      });
      probe.close?.();
    } catch {
      bitmap = probe;
    }

    const canvas = document.createElement("canvas");
    canvas.width = to.width;
    canvas.height = to.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { kind: "asis", file, from };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, to.width, to.height);

    const type = encodeType(file.type);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, 0.92));
    // Some encoders answer with an empty blob rather than null on failure.
    if (!blob || blob.size === 0) return { kind: "asis", file, from };

    const name = type === file.type ? file.name : file.name.replace(/\.[^.]+$/, "") + ".png";
    return { kind: "scaled", file: new File([blob], name, { type }), from, to };
  } catch {
    return { kind: "asis", file, from };
  } finally {
    bitmap.close?.();
  }
}

