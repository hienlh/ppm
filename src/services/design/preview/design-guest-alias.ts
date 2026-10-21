import { join, resolve } from "node:path";
import { previewDenied } from "../../../server/helpers/preview-asset-guard.ts";
import { lstatOrNull, resolveDesignsRoot } from "../design-paths.ts";
import { MANIFEST_FILE, DEFAULT_ENTRY } from "../design-manifest.ts";
import { DEFAULT_SYSTEM_ID, systemFilesDir } from "../design-systems-paths.ts";
import { containedFile, SYSTEMS_DIR_ALIAS, TOKENS_CSS_ALIAS, type ScopedAsset } from "./design-preview-scope.ts";
import type { DesignRef } from "./design-preview-tokens.ts";

/**
 * The design-system files a reviewer's view may load from outside the pinned snapshot.
 *
 * The owner's canvas resolves `systems/<id>/<rest>` against the app's whole files folder,
 * and for the `default` app that folder is `designs/` itself — every other design, and the
 * live copy of this one. A reviewer gets an allow-list instead, served live:
 * - `tokens.css`: the shared `designs/tokens.css`;
 * - `systems/<id>/tokens.css` and `systems/<id>/kit/**`, only for the app the snapshot's
 *   `design.json` names. For `default` those are `designs/tokens.css` and `designs/kit/**`.
 * Everything else under `systems/` is a 403: another app, `system.json`, `DESIGN.md`, and
 * `systems/default/<slug>/…`. A design whose slug is `kit` would make `designs/kit/` both a
 * design and the default kit, so while one exists the default `kit/**` is refused too.
 */

const KIT_DIR = "kit";

function segmentsOf(path: string): string[] {
  if (!path || path.includes("\\") || path.includes("\0") || path.includes(":")) previewDenied();
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) previewDenied();
  return segments;
}

/** `designs/kit/` is a design (it has a manifest or an entry page), not only a kit folder. */
async function kitIsADesign(root: string): Promise<boolean> {
  const dir = join(root, KIT_DIR);
  const [manifest, entry] = await Promise.all([lstatOrNull(join(dir, MANIFEST_FILE)), lstatOrNull(join(dir, DEFAULT_ENTRY))]);
  return !!manifest || !!entry;
}

/**
 * `path` (decoded, relative to the share's file root: `tokens.css` or `systems/…`) as a file
 * a reviewer may load, for a snapshot whose app is `systemId`. Throws `{status: 403}` for
 * anything outside the allow-list, ENOENT when an allowed file is missing.
 */
export async function resolveGuestAlias(design: DesignRef, systemId: string, path: string): Promise<ScopedAsset> {
  const segments = segmentsOf(path);
  const root = await resolveDesignsRoot(design.projectPath);
  if (!root) previewDenied();
  const designDir = join(root, design.slug);
  if (segments.length === 1 && segments[0] === TOKENS_CSS_ALIAS) {
    return { abs: await containedFile(root, join(root, TOKENS_CSS_ALIAS)), rel: `../${TOKENS_CSS_ALIAS}`, designDir };
  }
  if (segments[0] !== SYSTEMS_DIR_ALIAS || segments.length < 3) previewDenied();
  const [, id, ...rest] = segments as [string, string, ...string[]];
  if (id !== systemId) previewDenied();
  const isTokens = rest.length === 1 && rest[0] === TOKENS_CSS_ALIAS;
  const isKit = rest.length >= 2 && rest[0] === KIT_DIR;
  if (!isTokens && !isKit) previewDenied();
  if (isKit && id === DEFAULT_SYSTEM_ID && (await kitIsADesign(root))) previewDenied();
  // Contained in the kit folder itself, not just the app's: a `kit` that is a link to some
  // other folder under `designs/` would otherwise still pass a check against `designs/`.
  const base = isKit ? join(systemFilesDir(root, id), KIT_DIR) : systemFilesDir(root, id);
  const abs = await containedFile(base, resolve(base, ...(isKit ? rest.slice(1) : rest)));
  return { abs, rel: `../${path}`, designDir };
}
