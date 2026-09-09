/**
 * Which attachments are announced as already-included, and which as files to open.
 *
 * Split out from the composer so it can be asserted on. The decision looks obvious and is
 * not: it has to follow the payloads that actually go out, not merely which attachments have
 * one. The per-message caps can leave an image behind, and announcing that its contents are
 * included would hand the model neither the picture nor a reason to open the file.
 */

/** The parts of an attachment this split needs. */
export interface MarkerCandidate {
  serverPath?: string;
  imageData?: { data: string; mediaType: string };
}

export interface MarkerSplit {
  /** Uploaded paths whose payloads are travelling in this message. */
  inlineImagePaths: string[];
  /** Uploaded paths the model has to open for itself. */
  pathOnlyPaths: string[];
}

/**
 * Sort `attachments` by whether their payload is in `inlineImages`.
 *
 * An attachment with no uploaded path is in neither list: there is nothing to name. Identity
 * is what pairs a payload to its attachment — `inlineImages` holds the very objects the
 * attachments carry, so a second image with byte-identical data is not mistaken for the one
 * that was picked.
 */
export function splitAttachmentMarkers(
  attachments: MarkerCandidate[],
  inlineImages: Array<{ data: string; mediaType: string }>,
): MarkerSplit {
  const sent = new Set(inlineImages);
  const inlineImagePaths: string[] = [];
  const pathOnlyPaths: string[] = [];
  for (const a of attachments) {
    if (!a.serverPath) continue;
    if (a.imageData && sent.has(a.imageData)) inlineImagePaths.push(a.serverPath);
    else pathOnlyPaths.push(a.serverPath);
  }
  return { inlineImagePaths, pathOnlyPaths };
}
