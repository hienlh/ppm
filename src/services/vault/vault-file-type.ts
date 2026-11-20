import type { VaultFileType } from "../../shared/vault.ts";

/**
 * What a vault file is, decided from its own bytes and never from what a browser or a database
 * column says: JPEG, PNG, WebP or PDF, nothing that runs script on PPM's origin (SVG, HTML). Checked
 * on upload and again on every read, since `vault_attachments.mime` is not covered by encryption.
 */

const MAX_FILE_NAME = 255;

/** The file's type from its first bytes, or null for anything the vault does not store. */
export function sniffVaultFileType(bytes: Buffer): VaultFileType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** A file name safe to hand back in `Content-Disposition`: no path, no control characters. */
export function cleanFileName(name: unknown, type: VaultFileType): string {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }[type];
  let n = typeof name === "string" ? name : "";
  n = n.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, MAX_FILE_NAME);
  return n || `file.${ext}`;
}
