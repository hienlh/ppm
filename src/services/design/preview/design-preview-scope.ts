import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { guardPreviewAsset, isInsideRoot, previewDenied } from "../../../server/helpers/preview-asset-guard.ts";
import { resolveDesignDir, resolveDesignsRoot } from "../design-paths.ts";
import type { DesignRef } from "./design-preview-tokens.ts";

/**
 * Which file a preview request under one token may read.
 *
 * A token covers `designs/<slug>/**` and exactly one alias, `tokens.css`, which is the
 * shared `designs/tokens.css` (a design links it as `../tokens.css`, and from
 * `/content/<token>/<slug>/index.html` that resolves to `/content/<token>/tokens.css`).
 * Everything else — another design, `DESIGN.md`, anything under a dot-directory such as
 * the design's own `.design/` — is a 403.
 *
 * The design folder is re-resolved on every request rather than remembered from mint, so a
 * design deleted or swapped for a symlink after the token was issued stops being served.
 */

export const TOKENS_CSS_ALIAS = "tokens.css";

export interface ScopedAsset {
  abs: string;
  /** Path relative to the design folder, `/`-separated; `../tokens.css` for the alias. */
  rel: string;
  designDir: string;
}

function decodeRequestPath(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    previewDenied();
  }
}

async function containedFile(root: string, candidate: string): Promise<string> {
  if (!isInsideRoot(root, candidate)) previewDenied();
  guardPreviewAsset(candidate, root);
  const real = await realpath(candidate);
  if (!isInsideRoot(root, real)) previewDenied();
  guardPreviewAsset(real, root);
  return real;
}

/** Throws `{status: 403}` for anything outside the token's scope, ENOENT when missing. */
export async function resolveScopedAsset(design: DesignRef, encodedPath: string): Promise<ScopedAsset> {
  return resolveScopedPath(design, decodeRequestPath(encodedPath));
}

/** {@link resolveScopedAsset} for a path that is already decoded (`<slug>/…` or the alias). */
export async function resolveScopedPath(design: DesignRef, path: string): Promise<ScopedAsset> {
  // Checked after decoding, so `%2F`, `%5C` and `%00` cannot smuggle a separator past it.
  if (!path || path.includes("\\") || path.includes("\0") || path.includes(":")) previewDenied();
  const designDir = await resolveDesignDir(design.projectPath, design.slug);
  if (path === TOKENS_CSS_ALIAS) {
    const root = await resolveDesignsRoot(design.projectPath);
    if (!root) previewDenied();
    return { abs: await containedFile(root, join(root, TOKENS_CSS_ALIAS)), rel: `../${TOKENS_CSS_ALIAS}`, designDir };
  }
  const prefix = `${design.slug}/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) previewDenied();
  const candidate = resolve(designDir, path.slice(prefix.length));
  const abs = await containedFile(designDir, candidate);
  return { abs, rel: relative(designDir, candidate).split(sep).join("/"), designDir };
}
