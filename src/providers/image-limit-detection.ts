/**
 * Recognise the API refusing an image that the replayed transcript keeps re-sending.
 *
 * The API reports this as `invalid_request`, a code that also covers faults which must surface
 * to the user untouched, so the wording is what identifies it. Two phrasings are in use: one
 * naming the dimension cap and telling the user to start a new session, and a softer one saying
 * the image was removed.
 *
 * Wording alone is not enough to act on. A hit tears down the subprocess and rewrites the
 * user's transcript, dropping image payloads — and for an attachment that payload is usually
 * the only copy left. The same phrases are ordinary in any session that merely talks about
 * images ("the hero image is too large", "try fewer images"), so an ungated match would do
 * that damage to a perfectly healthy turn. Only the synthetic error record the CLI writes
 * carries `isApiErrorMessage`, which is what separates the two.
 */

const IMAGE_REJECTION_WORDING =
  /image[\s\S]{0,80}(dimension limit|could not be processed|too large)|fewer images/i;

/** True when this assistant message is the API refusing an image, not prose about one. */
export function isImageLimitRejection(msg: unknown): boolean {
  if ((msg as { isApiErrorMessage?: unknown } | null)?.isApiErrorMessage !== true) return false;
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return false;
  const text = content
    .filter((b: unknown) => (b as { type?: unknown })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b: unknown) => (b as { text: string }).text)
    .join("");
  return text.length > 0 && IMAGE_REJECTION_WORDING.test(text);
}
