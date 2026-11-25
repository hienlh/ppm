/**
 * Receipts for recordings that came in through PPM's own upload route (`POST /chat/upload`).
 *
 * A card reply from PPM's screen may say it was spoken only by naming a recording together with the
 * receipt that route handed out when it stored the file. The path check alone (`isStoredVoicePath`)
 * would let any caller of the REST route name any voice file already in the uploads folder (another
 * chat's, an old one) and present typed words as speech; a receipt ties the claim to one upload.
 *
 * The key lives in memory only: a receipt from before a restart is refused, and the person records
 * again. A receipt is good for six hours, long enough for a transcript left waiting for review.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = randomBytes(32);
/** How long a receipt stays good after the upload. */
export const VOICE_RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;
const RECEIPT_RE = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

const sign = (path: string, issuedAt: number): string =>
  createHmac("sha256", KEY).update(`ppm-voice-upload-v1\n${path}\n${issuedAt}`).digest("base64url");

/** The receipt for a recording just stored at `path`: `<issued ms>.<hmac>`. */
export function mintVoiceUploadReceipt(path: string, now: number = Date.now()): string {
  return `${now}.${sign(path, now)}`;
}

/** Whether `receipt` was handed out for this very path by this run of PPM, and is still good. */
export function verifyVoiceUploadReceipt(path: string, receipt: unknown, now: number = Date.now()): boolean {
  if (typeof receipt !== "string") return false;
  const m = RECEIPT_RE.exec(receipt);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  // A receipt from the future is as forged as one with the wrong signature.
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > VOICE_RECEIPT_TTL_MS) return false;
  const expected = Buffer.from(sign(path, issuedAt));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
