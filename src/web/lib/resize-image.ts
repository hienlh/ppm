/** Target square size (px) for project avatars. */
export const TARGET = 128;
/** Max accepted source file size before resize (10MB). */
export const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Center-crop an image file to a square and downscale to a 128×128 webp Blob.
 * Throws a user-facing Error for non-images or oversized files.
 */
export async function resizeImageToWebp(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please choose an image file");
  }
  if (file.size > MAX_BYTES) {
    throw new Error("Image too large (max 10MB)");
  }

  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - side) / 2;
  const sy = (bmp.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = TARGET;
  canvas.height = TARGET;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("Canvas not supported");
  }
  ctx.drawImage(bmp, sx, sy, side, side, 0, 0, TARGET, TARGET);
  bmp.close();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Encode failed"))),
      "image/webp",
      0.85,
    );
  });
}
