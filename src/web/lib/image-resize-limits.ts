/**
 * Ceilings on what may be sent as inline image payloads in one message.
 *
 * The chat socket refuses a message outright when it carries more than five images or one
 * above seven million base64 characters, and the WebSocket frame itself has a size past which
 * Bun closes the connection — which loses the message with nothing shown to the user. Both are
 * worth staying under by a margin rather than discovering at the boundary.
 *
 * Exceeding these is not an error: the attachment travels by path instead, which is how every
 * attachment worked before inlining existed.
 */
export const INLINE_IMAGE_LIMITS = {
  /** Server refuses a message carrying more than five. */
  maxImages: 4,
  /** Server refuses a single payload above 7,000,000 base64 characters. */
  maxBase64PerImage: 5_000_000,
  /** Frame budget across all payloads in one message, well under the 16 MiB default. */
  maxBase64Total: 10_000_000,
} as const;

/** The subset of an attachment this module needs to decide whether it can ride inline. */
export interface InlineCandidate {
  imageData?: { data: string; mediaType: string };
}

/**
 * The image payloads that may ride on one message, in order, up to those ceilings.
 *
 * An attachment past a ceiling is left out rather than refused: its path is still in the
 * message, so the model can open it the old way. A candidate that does not fit is skipped
 * instead of ending the scan, so one large image does not exclude the small ones after it.
 */
export function selectInlineImages(
  attachments: InlineCandidate[],
): Array<{ data: string; mediaType: string }> {
  const picked: Array<{ data: string; mediaType: string }> = [];
  let total = 0;
  for (const a of attachments) {
    if (!a.imageData) continue;
    if (picked.length >= INLINE_IMAGE_LIMITS.maxImages) break;
    if (a.imageData.data.length > INLINE_IMAGE_LIMITS.maxBase64PerImage) continue;
    if (total + a.imageData.data.length > INLINE_IMAGE_LIMITS.maxBase64Total) continue;
    total += a.imageData.data.length;
    picked.push(a.imageData);
  }
  return picked;
}
