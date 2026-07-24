/**
 * SHA-256 integrity verification for downloaded upgrade artifacts.
 *
 * Defends against corruption / partial downloads by checking the archive hash
 * against the `SHA256SUMS` manifest before it is ever extracted or swapped in.
 * Integrity only — the manifest is served from the same host, so this is not
 * authenticity (no signing key). GPG signing is a separate future concern.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Extract the hex hash for `filename` from standard `sha256sum` output
 * (`"<64-hex>  <filename>"`, two spaces). Returns null when the line is absent
 * or the hash is blank/malformed.
 */
export function parseSha256Sums(text: string, filename: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Tolerate 1+ spaces and an optional binary-mode `*` marker before the name.
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const [, hash, name] = match;
    if (name!.trim() === filename) return hash!.toLowerCase();
  }
  return null;
}

/** SHA-256 of a file as lowercase hex. */
export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Verify a file matches an expected SHA-256. Throws on mismatch or when the
 * expected hash is missing/blank — callers treat any throw as a fatal,
 * abort-the-upgrade condition.
 */
export function verifyChecksum(filePath: string, expectedHash: string | null): void {
  if (!expectedHash) {
    throw new Error("SHA256SUMS missing entry for artifact — refusing to upgrade");
  }
  const actual = sha256File(filePath);
  if (actual !== expectedHash.toLowerCase()) {
    throw new Error(`checksum mismatch: expected ${expectedHash}, got ${actual}`);
  }
}
