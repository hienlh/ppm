import { dirname, extname, isAbsolute, relative, sep } from "node:path";
import { assertAllowed, assertNotPpmDir } from "../../services/fs-path-guard.service.ts";

/**
 * The file-level rules every sandboxed preview route shares (the HTML file preview and the
 * design canvas): which files may be served at all, and which Host may be written into a
 * CSP directive.
 */

/** Web assets a preview may load. Anything else (dotenv, databases, keys) is a 403. */
export const PREVIEW_ASSET_EXTENSIONS = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".mp4", ".webm", ".mov", ".mp3", ".wav", ".ogg", ".m4a", ".woff", ".woff2", ".ttf", ".otf", ".vtt"]);

export function previewDenied(): never {
  throw Object.assign(new Error("Preview path is not allowed"), { status: 403 });
}

export function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function guardPreviewAsset(path: string, root = dirname(path)): void {
  assertAllowed(path);
  assertNotPpmDir(path);
  // Only web assets, never hidden directories, dotenv, database or key files.
  if (relative(root, path).split(/[\\/]/).some((part) => part.startsWith(".")) || !PREVIEW_ASSET_EXTENSIONS.has(extname(path).toLowerCase())) previewDenied();
}

/**
 * Bun reconstructs req.url with its listening port. Preserve the browser's Host through
 * Vite/tunnels; validate before inserting into a CSP directive.
 */
export function browserFacingHost(requestHost: string | undefined, requestUrl: string): string {
  const host = requestHost ?? "";
  return /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host) ? host : new URL(requestUrl).host;
}
