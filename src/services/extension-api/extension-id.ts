/** An extension id is its npm package name, scoped or not (`@ppm/ext-git-graph`). */
const EXTENSION_ID = /^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,113}$/i;

/** Whether `id` has the shape of an extension id: no spaces, no line breaks, bounded. */
export function isExtensionId(id: unknown): id is string {
  return typeof id === "string" && EXTENSION_ID.test(id);
}

/** `id` as it may appear in a log line: only id characters, at most 120 of them. */
export function loggableExtensionId(id: unknown): string {
  return String(id).replace(/[^A-Za-z0-9@/._~-]/g, "?").slice(0, 120);
}
