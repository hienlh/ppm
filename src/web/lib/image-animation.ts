/**
 * Whether an image file carries more than one frame.
 *
 * Re-encoding through a canvas keeps a single frame, so an animated image that goes through
 * the downscaler comes out silently flattened — and for the animations people paste into a
 * chat, a screen recording of a bug or a flow, the motion *is* the content. Better to leave
 * such a file at its original size than to shrink away the thing being shown.
 *
 * Detection reads container markers rather than decoding: an animated WebP declares an `ANIM`
 * chunk and an animated PNG an `acTL` chunk, both within the first few hundred bytes. GIF is
 * treated as animated without inspection — the marker for a still GIF is the *absence* of
 * extra frame separators, which cannot be established from a prefix, and a still GIF is rare
 * enough that assuming motion costs almost nothing.
 */

/** Bytes read from the front of a file to look for animation markers. */
const HEADER_BYTES = 4096;

function findAscii(bytes: Uint8Array, needle: string): boolean {
  const target = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + target.length <= bytes.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (bytes[i + j] !== target[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function hasAnimationMarker(type: string, header: Uint8Array): boolean {
  if (type === "image/gif") return true;
  if (type === "image/webp") return findAscii(header, "ANIM");
  if (type === "image/png" || type === "image/apng") return findAscii(header, "acTL");
  // AVIF sequences and anything unrecognised: not decodable here anyway, so the caller
  // falls back to sending the file by path.
  return false;
}

/** Read enough of `file` to answer, treating an unreadable file as animated (do not touch it). */
export async function isAnimatedImage(file: File): Promise<boolean> {
  if (file.type === "image/gif") return true;
  if (file.type !== "image/webp" && file.type !== "image/png" && file.type !== "image/apng") {
    return false;
  }
  try {
    const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
    return hasAnimationMarker(file.type, head);
  } catch {
    return true;
  }
}
