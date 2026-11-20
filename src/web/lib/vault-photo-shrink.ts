/**
 * A photo prepared for the vault before it leaves the browser: drawn again on a canvas, its
 * longest side at most `VAULT_PHOTO_MAX_SIDE`. Drawing it again is also what drops its EXIF block,
 * which can carry the GPS position the photo was taken at and the phone that took it. The camera's
 * rotation is applied first (`imageOrientation: "from-image"`), since the EXIF that held it is gone.
 *
 * A PDF, or a photo the user chose to keep as it is, goes up unchanged.
 */
import { VAULT_PHOTO_MAX_SIDE } from "../../shared/vault";

const SHRINKABLE = /^image\/(jpeg|png|webp)$/;

export const isPhoto = (type: string): boolean => SHRINKABLE.test(type);

/** The longest-side scale for a picture of `w` × `h`: never above 1, never enlarging. */
export function shrinkScale(w: number, h: number, maxSide = VAULT_PHOTO_MAX_SIDE): number {
  const longest = Math.max(w, h);
  return longest > maxSide ? maxSide / longest : 1;
}

export async function shrinkPhoto(file: File, maxSide = VAULT_PHOTO_MAX_SIDE): Promise<{ blob: Blob; name: string }> {
  if (!isPhoto(file.type)) return { blob: file, name: file.name };
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = shrinkScale(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser could not prepare the photo. Tick “Keep the original” to upload it as it is.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // PNG stays PNG (a scan with sharp text); JPEG and WebP become JPEG.
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
    if (!blob) throw new Error("This browser could not prepare the photo. Tick “Keep the original” to upload it as it is.");
    const stem = file.name.replace(/\.[^.]+$/, "") || "photo";
    return { blob, name: `${stem}.${type === "image/png" ? "png" : "jpg"}` };
  } finally {
    bitmap.close();
  }
}
