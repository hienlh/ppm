import { join, resolve } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { assertAllowed, assertNotPpmDir } from "../fs-path-guard.service.ts";
import { isInsideDir } from "../fs-ops/fs-real-path.ts";
import { isValidDesignSlug } from "./design-slug.ts";
import { DesignError } from "./design-error.ts";

/** Folder under the project root that holds every design and the shared design system. */
export const DESIGNS_DIR = "designs";
/** Per-design working data (snapshots, comments, restore journal). Never part of the design. */
export const DOT_DESIGN = ".design";

/** `<project>/designs`, lexically. Use {@link resolveDesignsRoot} before touching the disk. */
export function designsRoot(projectPath: string): string {
  return join(resolve(projectPath), DESIGNS_DIR);
}

/** lstat that answers null for "not there" instead of throwing. */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

const refuse = (message: string): DesignError => new DesignError(403, "EDESIGNPATH", message);

/**
 * `designs/` resolved to its real path, or null when it does not exist yet.
 *
 * A symlinked `designs/` is refused outright rather than followed: every design path is
 * built from it, so a link there would silently move every read, write, snapshot and
 * delete to wherever it points — including the PPM directory.
 */
export async function resolveDesignsRoot(projectPath: string, opts: { create?: boolean } = {}): Promise<string | null> {
  const project = resolve(projectPath);
  assertAllowed(project);
  const root = designsRoot(project);
  assertNotPpmDir(root);
  let st = await lstatOrNull(root);
  if (!st && opts.create) {
    // Non-recursive on purpose: the project folder exists, and a recursive mkdir can throw
    // EEXIST on Windows folders carrying the read-only attribute.
    try {
      await mkdir(root);
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
    st = await lstatOrNull(root);
  }
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) throw refuse(`${DESIGNS_DIR}/ must be a real directory`);
  const [realProject, realRoot] = await Promise.all([realpath(project), realpath(root)]);
  if (!isInsideDir(realRoot, realProject)) throw refuse(`${DESIGNS_DIR}/ resolves outside the project`);
  assertNotPpmDir(realRoot);
  return realRoot;
}

/**
 * Absolute real path of `designs/<slug>/`, after validating the slug, refusing a symlinked
 * `designs/` or design folder, and checking realpath containment plus the credential guard.
 *
 * `mustExist: false` returns the would-be path of a design that does not exist yet (used by
 * creation), still under the same checks for everything that does exist.
 */
export async function resolveDesignDir(
  projectPath: string,
  slug: string,
  opts: { mustExist?: boolean } = {},
): Promise<string> {
  const mustExist = opts.mustExist ?? true;
  if (!isValidDesignSlug(slug)) throw new DesignError(400, "EBADSLUG", "Invalid design slug");
  const root = await resolveDesignsRoot(projectPath, { create: !mustExist });
  const notFound = new DesignError(404, "ENOENT", `Design not found: ${slug}`);
  if (!root) throw notFound;
  const dir = join(root, slug);
  const st = await lstatOrNull(dir);
  if (!st) {
    if (mustExist) throw notFound;
    return dir;
  }
  if (st.isSymbolicLink()) throw refuse("A design folder may not be a symlink");
  if (!st.isDirectory()) throw mustExist ? notFound : refuse(`${DESIGNS_DIR}/${slug} is not a directory`);
  const real = await realpath(dir);
  if (real === root || !isInsideDir(real, root)) throw refuse("Design folder resolves outside designs/");
  assertNotPpmDir(real);
  return real;
}

/** `designs/<slug>/.design`, for a design dir already returned by {@link resolveDesignDir}. */
export function dotDesignDir(designDir: string): string {
  return join(designDir, DOT_DESIGN);
}
