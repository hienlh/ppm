/**
 * Percent-encode a filename for the RFC 5987 `filename*` form.
 * `encodeURIComponent` leaves `'`, `(`, `)` and `*`, which are not attr-chars
 * there, so a name containing them would produce a header value a strict
 * parser rejects.
 */
export function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `Content-Disposition` for a download, with a UTF-8 safe filename. */
export function attachmentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
