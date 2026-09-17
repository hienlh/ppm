/**
 * Is this file content binary?
 *
 * The answer has to be taken from *bytes*. `git show` hands simple-git a string
 * decoded as UTF-8, and a PNG survives that as megabytes of U+FFFD — which is
 * exactly what the diff editor used to render, line-numbered and highlighted,
 * for every image in a commit.
 */

/** git's own window (`buffer_is_binary`, FIRST_FEW_BYTES in xdiff-interface.c). */
export const BINARY_SNIFF_BYTES = 8000;

/**
 * True when `bytes` looks binary — a NUL inside the first 8000 bytes.
 *
 * The same rule git applies when it prints "Binary files differ" instead of a
 * diff, and the same shape as `file.service`'s check for whether to answer
 * base64, so the diff view and the editor agree about any given file. A side
 * that does not exist (`null`) is not binary: an added file has no old version,
 * and that alone must not send the pair down the binary path.
 */
export function isBinaryContent(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes) return false;
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
