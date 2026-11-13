import { resolve, relative, isAbsolute } from "node:path";
import { getPpmDir } from "./ppm-dir.ts";

/**
 * The folder an extension id becomes under `<ppm dir>/extension-data/`.
 *
 * npm ids carry `@` and `/` (`@scope/name`), which become `__` so a scoped id is one folder
 * rather than two (`__scope__name`). Anything else outside npm's own name alphabet is refused
 * rather than rewritten: an id holding `..`, `\` or a drive colon is not a name, it is a path,
 * and a quiet rewrite would only hide where it was trying to go.
 */
export function extensionDataDirName(id: string): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("Extension id is empty");
  if (id.includes("..")) throw new Error(`Extension id may not contain "..": ${id}`);
  const name = id.replace(/[/@]/g, "__");
  if (!/^[A-Za-z0-9._~-]+$/.test(name) || name === ".") {
    throw new Error(`Extension id is not a valid folder name: ${id}`);
  }
  return name;
}

/**
 * Where an extension keeps its own data: inside PPM's directory, never beside its code. A
 * dev-linked extension's code folder is a link into its source repository, so data written
 * there would land in the repo, next to files a rebuild replaces. Removing the extension
 * leaves this folder alone — the data outlives the code.
 */
export function extensionDataDir(id: string): string {
  const root = resolve(getPpmDir(), "extension-data");
  const dir = resolve(root, extensionDataDirName(id));
  const rel = relative(root, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Extension data dir escapes its root: ${id}`);
  return dir;
}
