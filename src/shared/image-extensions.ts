/**
 * Image file extensions, shared by the raw-file route and the chat image renderer so the
 * server never refuses a path the UI is about to render (or the reverse).
 *
 * SVG is deliberately absent. The raw-file route serves files inline with their real
 * Content-Type and accepts a `?token=` query parameter, so an SVG streamed from an arbitrary
 * path could execute script in the app's own origin. `Read` also returns SVG as text, so
 * there is nothing to display anyway.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico",
]);

/** Check whether a path names an image file, by extension. */
export function isImageExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
