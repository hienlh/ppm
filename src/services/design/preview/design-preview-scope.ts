import { realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { guardPreviewAsset, isInsideRoot, previewDenied } from "../../../server/helpers/preview-asset-guard.ts";
import { resolveDesignDir, resolveDesignsRoot } from "../design-paths.ts";
import { systemFilesDir } from "../design-systems-paths.ts";
import { parseSystemsAliasTail } from "./design-systems-alias.ts";
import type { DesignRef } from "./design-preview-tokens.ts";

/**
 * Which file a preview request under one token may read.
 *
 * A token covers `designs/<slug>/**` and two aliases: `tokens.css`, the shared
 * `designs/tokens.css` (a design links it as `../tokens.css`), and `systems/<id>/**`, one
 * app's read-only design-system folder (a design links `../systems/<id>/tokens.css`,
 * `../systems/<id>/kit/app.css`, `../systems/<id>/kit/icons/<name>.svg`…) — for the `default`
 * app this remaps to the legacy `designs/` root rather than `designs/systems/default/`, since
 * those files are never moved. From `/content/<token>/<slug>/index.html` those resolve to
 * `/content/<token>/tokens.css` and `/content/<token>/systems/<id>/…`. Everything else —
 * another design, `DESIGN.md`, anything under a dot-directory such as the design's own
 * `.design/` — is a 403.
 *
 * The design folder is re-resolved on every request rather than remembered from mint, so a
 * design deleted or swapped for a symlink after the token was issued stops being served.
 */

export const TOKENS_CSS_ALIAS = "tokens.css";
/** Bare alias prefix; a request under it is `systems/<id>/<rest>`, never the directory itself. */
export const SYSTEMS_DIR_ALIAS = "systems";

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
  if (path === SYSTEMS_DIR_ALIAS || path.startsWith(`${SYSTEMS_DIR_ALIAS}/`)) {
    const root = await resolveDesignsRoot(design.projectPath);
    if (!root) previewDenied();
    // "" for bare "systems", else "<id>/sub/path"
    const tail = path.slice(SYSTEMS_DIR_ALIAS.length + 1);
    const parsed = tail ? parseSystemsAliasTail(tail) : null;
    if (!parsed || !parsed.rest) previewDenied();
    const segments = parsed.rest.split("/");
    if (segments.some((s) => s === "" || s === ".." || s.startsWith("."))) previewDenied();
    const base = systemFilesDir(root, parsed.id);
    const candidate = resolve(base, ...segments);
    const abs = await containedFile(base, candidate);
    return { abs, rel: `../${path}`, designDir };
  }
  const prefix = `${design.slug}/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) previewDenied();
  const candidate = resolve(designDir, path.slice(prefix.length));
  const abs = await containedFile(designDir, candidate);
  return { abs, rel: relative(designDir, candidate).split(sep).join("/"), designDir };
}
