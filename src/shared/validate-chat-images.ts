/** One inline image attached to a chat turn — shared by the WS `message` frame and
 *  the headless turn body (REST and extension RPC). */
export interface ChatImageInput {
  data: string;
  mediaType: string;
}

const MAX_IMAGES = 5;
const MAX_BASE64_SIZE = 7_000_000; // ~5MB decoded
const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Validate an inbound chat image payload — extracted so the WS `message` handler
 * and the headless turn reject the same oversized or unsupported images instead
 * of drifting apart.
 *
 * Returns `null` when valid, otherwise a user-facing error message describing the
 * first violation found.
 */
export function validateChatImages(images: ChatImageInput[] | undefined): string | null {
  if (!images?.length) return null;
  if (images.length > MAX_IMAGES) return `Max ${MAX_IMAGES} images per message`;
  for (const img of images) {
    if (typeof img?.data !== "string" || typeof img?.mediaType !== "string") return "Each image needs data and mediaType";
    if (img.data.length > MAX_BASE64_SIZE) return "Image too large (max 5MB)";
    if (!SUPPORTED_TYPES.has(img.mediaType)) return `Unsupported image type: ${img.mediaType}`;
  }
  return null;
}
