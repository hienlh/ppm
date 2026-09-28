import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertNotPpmDir, isCredentialPath } from "../../fs-path-guard.service.ts";
import { guardPreviewAsset, isInsideRoot } from "../../../server/helpers/preview-asset-guard.ts";
import { lstatOrNull } from "../design-paths.ts";
import { readDesignFileSafe, SafeWalkError } from "../design-safe-walk.ts";

/**
 * How the standalone-HTML export reads the files a page links: by path relative to the
 * design folder, through the same guards as everything else that reads a design tree.
 *
 * A design is written by an agent, so a link in it can point anywhere. A file is read only
 * when it is inside the design folder (or is the shared `../tokens.css`), is a web asset by
 * extension, sits under no dot-directory, is a regular file and not a symlink, still resolves
 * inside after `realpath`, is no credential path and not inside the PPM directory — and then
 * through `readDesignFileSafe`, which re-checks the open handle. Everything else answers
 * `refused`, never an exception, so one bad link costs one warning rather than the export.
 */

export type ReadAssetResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "missing" | "refused" | "too-large" };

/** `rel` is `/`-separated and relative to the design folder; `../tokens.css` is the one way out. */
export type ReadAsset = (rel: string, maxBytes: number) => Promise<ReadAssetResult>;

export const TOKENS_CSS_REL = "../tokens.css";

export function createDesignAssetReader(designDir: string, designsRoot: string): ReadAsset {
  return async (rel, maxBytes) => {
    const tokens = rel === TOKENS_CSS_REL;
    const root = tokens ? designsRoot : designDir;
    if (!tokens && (rel === "" || rel.includes("\0") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s.startsWith(".")))) {
      return { ok: false, reason: "refused" };
    }
    const target = tokens ? join(designsRoot, "tokens.css") : resolve(designDir, ...rel.split("/"));
    try {
      if (!isInsideRoot(root, target)) return { ok: false, reason: "refused" };
      guardPreviewAsset(target, root);
      const st = await lstatOrNull(target);
      if (!st) return { ok: false, reason: "missing" };
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "refused" };
      const real = await realpath(target);
      if (!isInsideRoot(root, real) || isCredentialPath(target) || isCredentialPath(real)) return { ok: false, reason: "refused" };
      assertNotPpmDir(real);
      if (st.size > maxBytes) return { ok: false, reason: "too-large" };
      return { ok: true, bytes: await readDesignFileSafe(target, maxBytes) };
    } catch (e) {
      if (e instanceof SafeWalkError && e.code === "ETOOBIG") return { ok: false, reason: "too-large" };
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
      const status = (e as { status?: number }).status;
      if (status === 403 || code === "ELOOP" || code === "EACCES" || code === "EPERM") return { ok: false, reason: "refused" };
      throw e;
    }
  };
}
